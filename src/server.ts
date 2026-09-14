import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config, corsOrigins } from './config.js';
import { requireAdmin, requireUser } from './auth.js';
import { coordinates, currencyRateInput, deliveryStatusInput, donationIntentInput, foodDonationInput, generalDonationInput, locationInput, mealRequestInput, mealTypeUpdateInput, messageInput, pushDeviceInput, ratingInput } from './schemas.js';
import './types.js';

const app = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' }, bodyLimit: 256 * 1024, trustProxy: config.TRUST_PROXY });
const publicSupabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, { auth: { persistSession: false }, realtime: { transport: WebSocket as any } });
const serviceSupabase = config.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }, realtime: { transport: WebSocket as any } })
  : null;

const REQUEST_DISCOVERY_WINDOW_MS = 30 * 60 * 1000;
const EARTH_RADIUS_KM = 6371;

function distanceKm(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(toLat - fromLat);
  const dLng = radians(toLng - fromLng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(fromLat)) * Math.cos(radians(toLat)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

await app.register(helmet, { contentSecurityPolicy: false });
await app.register(cors, { origin: corsOrigins, credentials: true });
await app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW });
await app.register(sensible);

app.get('/healthz', async () => ({ status: 'ok', service: 'sharek-api', time: new Date().toISOString() }));

app.register(async (api) => {
  api.addHook('preHandler', requireUser);

  api.get('/me', async (request) => {
    const [profile, settings] = await Promise.all([
      request.supabase.from('profiles').select('*').eq('id', request.user.id).maybeSingle(),
      request.supabase.from('user_settings').select('*').eq('user_id', request.user.id).maybeSingle(),
    ]);
    if (profile.error || settings.error) throw app.httpErrors.internalServerError('Unable to load account');
    return { profile: profile.data, settings: settings.data };
  });

  api.post('/devices/push', async (request) => {
    const parsed = pushDeviceInput.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    const { data, error } = await request.supabase
      .from('push_devices')
      .upsert({ user_id: request.user.id, ...parsed.data, enabled: true, last_seen_at: new Date().toISOString() }, { onConflict: 'user_id,expo_push_token' })
      .select('id, platform, enabled, last_seen_at')
      .single();
    if (error) throw app.httpErrors.internalServerError('Unable to register push device');
    return data;
  });

  api.delete('/devices/push/:token', async (request) => {
    const token = decodeURIComponent((request.params as { token: string }).token);
    if (!/^Expo\[.+\]$|^ExponentPushToken\[.+\]$/.test(token)) throw app.httpErrors.badRequest('Invalid push token');
    const { error } = await request.supabase.from('push_devices').delete().eq('user_id', request.user.id).eq('expo_push_token', token);
    if (error) throw app.httpErrors.internalServerError('Unable to remove push device');
    return { ok: true };
  });

  api.get('/map/nearby', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const parsed = coordinates.safeParse({ latitude: Number(query.latitude), longitude: Number(query.longitude) });
    if (!parsed.success) throw app.httpErrors.badRequest('Invalid coordinates');
    const radius = Math.min(Math.max(Number(query.radius_km ?? 25), 1), 50);
    const discoveryDb = serviceSupabase ?? request.supabase;
    const requestCutoff = new Date(Date.now() - REQUEST_DISCOVERY_WINDOW_MS).toISOString();
    const now = new Date().toISOString();
    const [openRequests, availableFood] = await Promise.all([
      discoveryDb
        .from('meal_requests')
        .select('id,user_id,meals,timing,status,latitude,longitude,created_at,updated_at')
        .eq('status', 'open')
        .gt('created_at', requestCutoff)
        .order('created_at', { ascending: false })
        .limit(200),
      discoveryDb
        .from('food_donations')
        .select('id,user_id,food_name,meals,latitude,longitude,expires_at,created_at')
        .eq('status', 'available')
        .gt('expires_at', now)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);
    if (openRequests.error || availableFood.error) throw app.httpErrors.internalServerError('Unable to load nearby items');

    const nearbyRequests = (openRequests.data ?? []).map((item) => ({
      item_type: 'request' as const,
      item_id: item.id,
      user_id: item.user_id,
      title: 'Meal request',
      meals: item.meals,
      timing: item.timing,
      status: item.status,
      latitude: Math.round(item.latitude * 1000) / 1000,
      longitude: Math.round(item.longitude * 1000) / 1000,
      created_at: item.created_at,
      updated_at: item.updated_at,
      expires_at: new Date(new Date(item.created_at).getTime() + REQUEST_DISCOVERY_WINDOW_MS).toISOString(),
    }));
    const nearbyFood = (availableFood.data ?? []).map((item) => ({
      item_type: 'food' as const,
      item_id: item.id,
      user_id: item.user_id,
      title: item.food_name,
      meals: item.meals,
      latitude: Math.round(item.latitude * 1000) / 1000,
      longitude: Math.round(item.longitude * 1000) / 1000,
      expires_at: item.expires_at,
      created_at: item.created_at,
    }));
    const items = [...nearbyRequests, ...nearbyFood]
      .map((item) => ({ ...item, distance_km: distanceKm(parsed.data.latitude, parsed.data.longitude, item.latitude, item.longitude) }))
      .filter((item) => item.distance_km <= radius)
      .sort((a, b) => a.distance_km - b.distance_km);
    return { items };
  });

  api.post('/meal-requests', async (request, reply) => {
    const parsed = mealRequestInput.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    const { meals, timing, latitude, longitude } = parsed.data;
    const { data, error } = await request.supabase.from('meal_requests').insert({ user_id: request.user.id, meals, timing, latitude, longitude }).select().single();
    if (error) throw app.httpErrors.internalServerError('Unable to create meal request');
    return reply.code(201).send(data);
  });

  api.get('/meal-requests/open', async (request) => {
    const { data, error } = await request.supabase.from('meal_requests').select('*').eq('status', 'open').neq('user_id', request.user.id).order('created_at', { ascending: false }).limit(100);
    if (error) throw app.httpErrors.internalServerError('Unable to load requests');
    return { items: data ?? [] };
  });

  api.post('/meal-requests/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    const { data, error } = await request.supabase.from('meal_requests').update({ status: 'cancelled' }).eq('id', id).eq('user_id', request.user.id).eq('status', 'open').select().maybeSingle();
    if (error) throw app.httpErrors.internalServerError('Unable to cancel request');
    if (!data) throw app.httpErrors.conflict('Request is no longer open');
    return data;
  });

  api.post('/meal-requests/:id/offers', async (request, reply) => {
    const parsed = coordinates.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    const { id } = request.params as { id: string };
    const requestRow = await request.supabase.from('meal_requests').select('meals,status,user_id').eq('id', id).maybeSingle();
    if (requestRow.error || !requestRow.data) throw app.httpErrors.notFound('Request not found');
    if (requestRow.data.status !== 'open' || requestRow.data.user_id === request.user.id) throw app.httpErrors.conflict('Request is not available');
    const { data, error } = await request.supabase.from('offers').upsert({ request_id: id, helper_id: request.user.id, offered_meals: requestRow.data.meals, latitude: parsed.data.latitude, longitude: parsed.data.longitude, status: 'pending', response_expires_at: new Date(Date.now() + 15_000).toISOString() }, { onConflict: 'request_id,helper_id' }).select().single();
    if (error) throw app.httpErrors.internalServerError('Unable to send offer');
    return reply.code(201).send(data);
  });

  api.post('/meal-requests/:id/accept', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = coordinates.partial().safeParse(request.body ?? {});
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    const { data, error } = await request.supabase.rpc('accept_meal_request', { p_request_id: id, p_helper_lat: parsed.data.latitude ?? null, p_helper_lng: parsed.data.longitude ?? null });
    if (error) throw app.httpErrors.conflict(error.message);
    return data;
  });

  api.post('/meal-requests/:id/offers/:offerId/accept', async (request) => {
    const { id, offerId } = request.params as { id: string; offerId: string };
    const { data: offer, error: offerError } = await request.supabase.from('offers').select('request_id').eq('id', offerId).maybeSingle();
    if (offerError || !offer || offer.request_id !== id) throw app.httpErrors.notFound('Offer not found');
    const { data, error } = await request.supabase.rpc('accept_offer', { p_offer_id: offerId });
    if (error) throw app.httpErrors.conflict(error.message);
    return data;
  });

  api.post('/meal-requests/:id/offers/:offerId/decline', async (request) => {
    const { id, offerId } = request.params as { id: string; offerId: string };
    const { data, error } = await request.supabase.from('offers').update({ status: 'declined', updated_at: new Date().toISOString() }).eq('id', offerId).eq('request_id', id).eq('status', 'pending').select().maybeSingle();
    if (error) throw app.httpErrors.internalServerError('Unable to decline offer');
    if (!data) throw app.httpErrors.conflict('Offer is no longer pending');
    return data;
  });

  api.get('/matches/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { data, error } = await request.supabase.from('matches').select('*').eq('id', id).maybeSingle();
    if (error) throw app.httpErrors.internalServerError('Unable to load match');
    if (!data) throw app.httpErrors.notFound('Match not found');
    return data;
  });

  api.post('/matches/:id/location', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = locationInput.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    const { error } = await request.supabase.rpc('update_helper_location', { p_match_id: id, p_lat: parsed.data.latitude, p_lng: parsed.data.longitude });
    if (error) throw app.httpErrors.forbidden('Unable to update location');
    return { ok: true };
  });

  api.post('/matches/:id/requester-location', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = locationInput.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    const { error } = await request.supabase.rpc('update_requester_location', { p_match_id: id, p_lat: parsed.data.latitude, p_lng: parsed.data.longitude });
    if (error) throw app.httpErrors.forbidden('Unable to update location');
    return { ok: true };
  });

  api.patch('/matches/:id/status', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = deliveryStatusInput.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    const { data, error } = await request.supabase.rpc('update_delivery_status', { p_match_id: id, p_status: parsed.data.status });
    if (error) throw app.httpErrors.forbidden(error.message);
    return data;
  });

  api.post('/matches/:id/confirm-receipt', async (request) => {
    const { id } = request.params as { id: string };
    const { data, error } = await request.supabase.rpc('confirm_match_receipt', { p_match_id: id });
    if (error) throw app.httpErrors.forbidden(error.message);
    return data;
  });

  api.post('/food-donations', async (request, reply) => {
    const parsed = foodDonationInput.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    const db = serviceSupabase ?? request.supabase;
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('role')
      .eq('id', request.user.id)
      .maybeSingle();
    if (profileError) throw app.httpErrors.internalServerError('Unable to verify account role');
    if (!profile || !['donor', 'charity', 'restaurant', 'hotel'].includes(profile.role)) {
      throw app.httpErrors.forbidden('Only donors can publish food');
    }
    const { data, error } = await db.from('food_donations').insert({ ...parsed.data, user_id: request.user.id, status: 'available' }).select().single();
    if (error) {
      request.log.error({ err: error }, 'food publish failed');
      throw app.httpErrors.internalServerError('Unable to publish food');
    }
    return reply.code(201).send(data);
  });

  api.get('/food-donations/open', async (request) => {
    await request.supabase.rpc('expire_food_donations');
    const { data, error } = await request.supabase.from('food_donations').select('*').eq('status', 'available').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(100);
    if (error) throw app.httpErrors.internalServerError('Unable to load food');
    return { items: data ?? [] };
  });

  api.post('/food-donations/:id/claim', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = coordinates.partial().safeParse(request.body ?? {});
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    const { data, error } = await request.supabase.rpc('claim_food_donation', { p_donation_id: id, p_claimer_lat: parsed.data.latitude ?? null, p_claimer_lng: parsed.data.longitude ?? null });
    if (error) throw app.httpErrors.conflict(error.message);
    return data;
  });

  api.post('/food-claims/:id/location', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = locationInput.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    const { error } = await request.supabase.rpc('update_food_claim_location', { p_claim_id: id, p_lat: parsed.data.latitude, p_lng: parsed.data.longitude });
    if (error) throw app.httpErrors.forbidden('Unable to update claim location');
    return { ok: true };
  });

  api.post('/food-claims/:id/confirm-pickup', async (request) => {
    const { id } = request.params as { id: string };
    const { data, error } = await request.supabase.rpc('confirm_food_claim_pickup', { p_claim_id: id });
    if (error) throw app.httpErrors.conflict(error.message);
    return data;
  });

  api.get('/chat/:kind/:id', async (request) => {
    const { kind, id } = request.params as { kind: string; id: string };
    if (!['food', 'request'].includes(kind)) throw app.httpErrors.badRequest('Invalid chat scope');
    const field = kind === 'food' ? 'food_donation_id' : 'meal_request_id';
    const { data, error } = await request.supabase.from('messages').select('*').eq(field, id).order('created_at', { ascending: true }).limit(500);
    if (error) throw app.httpErrors.forbidden('Unable to load chat');
    return { items: data ?? [] };
  });

  api.post('/chat/:kind/:id/messages', async (request, reply) => {
    const { kind, id } = request.params as { kind: string; id: string };
    const parsed = messageInput.safeParse(request.body);
    if (!parsed.success || !['food', 'request'].includes(kind)) throw app.httpErrors.badRequest(parsed.success ? 'Invalid chat scope' : parsed.error.flatten());
    const payload: Record<string, unknown> = { ...(kind === 'food' ? { food_donation_id: id } : { meal_request_id: id }), sender_id: request.user.id, recipient_id: parsed.data.recipient_id, body: parsed.data.body };
    const { data, error } = await request.supabase.from('messages').insert(payload).select().single();
    if (error) throw app.httpErrors.forbidden('Unable to send message');
    return reply.code(201).send(data);
  });

  api.get('/pricing', async (request) => {
    const query = request.query as { currency?: string };
    const currency = (query.currency ?? config.DEFAULT_CURRENCY).toUpperCase();
    const [types, rate] = await Promise.all([
      request.supabase.from('meal_types').select('*').eq('is_active', true).order('price_usd'),
      request.supabase.from('currency_rates').select('rate').eq('currency', currency).maybeSingle(),
    ]);
    if (types.error || rate.error) throw app.httpErrors.internalServerError('Unable to load pricing');
    const fx = currency === 'USD' ? 1 : rate.data?.rate;
    if (!fx) throw app.httpErrors.badRequest('Currency is not configured');
    return { currency, usd_to_local_rate: fx, meal_types: (types.data ?? []).map((item) => ({ ...item, local_price: Number(item.price_usd) * Number(fx) })) };
  });

  api.get('/charities', async (request) => {
    const { data, error } = await request.supabase.from('public_profiles').select('id,full_name,avatar_url,rating').eq('role', 'charity').order('full_name').limit(100);
    if (error) throw app.httpErrors.internalServerError('Unable to load charities');
    return { items: data ?? [] };
  });

  api.post('/donations/intent', async (request, reply) => {
    // Payments are intentionally disabled until SHARek is legally and commercially
    // ready to connect a real payment gateway and signed webhook.
    const parsed = donationIntentInput.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    return reply.code(410).send({
      error: 'PAYMENTS_DISABLED',
      message: 'Financial donations are currently disabled.',
    });
  });

  api.post('/donations/general', async (request, reply) => {
    // Payments are intentionally disabled until SHARek is legally and commercially
    // ready to connect a real payment gateway and signed webhook.
    const parsed = generalDonationInput.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    return reply.code(410).send({
      error: 'PAYMENTS_DISABLED',
      message: 'Financial donations are currently disabled.',
    });
  });

  api.get('/history', async (request) => {
    const uid = request.user.id;
    const db = serviceSupabase ?? request.supabase;
    const [requests, foodClaims, helperMatches] = await Promise.all([
      db.from('meal_requests').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(100),
      db.from('food_claims').select('*').eq('claimer_id', uid).order('created_at', { ascending: false }).limit(100),
      db.from('matches').select('*').eq('helper_id', uid).order('created_at', { ascending: false }).limit(100),
    ]);
    if ([requests, foodClaims, helperMatches].some((result) => result.error)) {
      request.log.error({ errors: [requests.error, foodClaims.error, helperMatches.error].filter(Boolean) }, 'history load failed');
      throw app.httpErrors.internalServerError('Unable to load history');
    }

    const requestIds = (requests.data ?? []).map((item) => item.id);
    const requesterMatches = requestIds.length
      ? await db.from('matches').select('*').in('request_id', requestIds).order('created_at', { ascending: false }).limit(100)
      : { data: [], error: null };
    if (requesterMatches.error) {
      request.log.error({ err: requesterMatches.error }, 'requester history load failed');
      throw app.httpErrors.internalServerError('Unable to load history');
    }

    const matches = [...(helperMatches.data ?? []), ...(requesterMatches.data ?? [])]
      .filter((match, index, all) => all.findIndex((candidate) => candidate.id === match.id) === index)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 100);
    return { donations: [], requests: requests.data ?? [], food_claims: foodClaims.data ?? [], matches };
  });

  api.post('/matches/:id/ratings', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ratingInput.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
    const { data, error } = await request.supabase.rpc('submit_rating', { p_match_id: id, p_score: parsed.data.score, p_comment: parsed.data.comment ?? null });
    if (error) throw app.httpErrors.conflict('Rating already submitted or match is not eligible');
    return reply.code(201).send(data);
  });

  api.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);
    admin.get('/admin/meal-types', async (request) => {
      const { data, error } = await request.supabase.from('meal_types').select('*').order('created_at');
      if (error) throw app.httpErrors.internalServerError('Unable to load meal types');
      return { items: data ?? [] };
    });
    admin.get('/admin/price-history', async (request) => {
      const { data, error } = await request.supabase.from('meal_price_history').select('*').order('changed_at', { ascending: false }).limit(200);
      if (error) throw app.httpErrors.internalServerError('Unable to load price history');
      return { items: data ?? [] };
    });
    admin.patch('/admin/meal-types/:id', async (request) => {
      const { id } = request.params as { id: string };
      const parsed = mealTypeUpdateInput.safeParse(request.body);
      if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
      const { data, error } = await request.supabase.from('meal_types').update(parsed.data).eq('id', id).select().single();
      if (error) throw app.httpErrors.badRequest('Unable to update meal type');
      return data;
    });
    admin.post('/admin/currency-rates/:currency', async (request) => {
      const { currency } = request.params as { currency: string };
      if (!/^[A-Za-z]{3}$/.test(currency)) throw app.httpErrors.badRequest('Invalid currency');
      const parsed = currencyRateInput.safeParse(request.body);
      if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.flatten());
      const { data, error } = await request.supabase.from('currency_rates').upsert({ currency: currency.toUpperCase(), rate: parsed.data.rate, updated_by: request.user.id }, { onConflict: 'currency' }).select().single();
      if (error) throw app.httpErrors.badRequest('Unable to update exchange rate');
      return data;
    });
  });
}, { prefix: '/v1' });

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, 'request failed');
  const typed = error as { validation?: unknown; statusCode?: number; message: string };
  const status = typed.validation ? 400 : (typed.statusCode && typed.statusCode >= 400 ? typed.statusCode : 500);
  return reply.code(status).send({ error: status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR', message: status === 500 ? 'Unexpected server error' : typed.message });
});

export { app, publicSupabase };

if (process.env.NODE_ENV !== 'test') await app.listen({ port: config.PORT, host: '0.0.0.0' });
