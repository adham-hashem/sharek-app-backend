import { z } from 'zod';

export const coordinates = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

export const mealRequestInput = coordinates.extend({ meals: z.number().int().min(1).max(100), timing: z.enum(['now', 'later']) });

export const foodDonationInput = coordinates.extend({
  food_name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(''),
  image_url: z.string().url().nullable().optional(),
  meals: z.number().int().min(1).max(1000),
  pickup_start: z.string().datetime(),
  pickup_end: z.string().datetime(),
  expires_at: z.string().datetime(),
  food_type: z.string().trim().max(40).optional(),
  prepared_at: z.string().datetime().nullable().optional(),
  storage_method: z.string().trim().max(40).optional(),
  allergens: z.string().trim().max(500).optional(),
}).superRefine((value, ctx) => {
  if (new Date(value.expires_at).getTime() <= Date.now()) ctx.addIssue({ code: 'custom', path: ['expires_at'], message: 'Expiry must be in the future' });
  if (new Date(value.expires_at).getTime() > Date.now() + 72 * 60 * 60 * 1000) ctx.addIssue({ code: 'custom', path: ['expires_at'], message: 'Expiry cannot be more than 72 hours away' });
  if (new Date(value.pickup_start).getTime() < Date.now() - 5 * 60 * 1000) ctx.addIssue({ code: 'custom', path: ['pickup_start'], message: 'Pickup start is too far in the past' });
  if (new Date(value.pickup_end).getTime() < new Date(value.pickup_start).getTime()) ctx.addIssue({ code: 'custom', path: ['pickup_end'], message: 'Pickup window is invalid' });
  if (new Date(value.expires_at).getTime() < new Date(value.pickup_end).getTime()) ctx.addIssue({ code: 'custom', path: ['expires_at'], message: 'Expiry cannot be before pickup end' });
});

export const locationInput = coordinates;
export const deliveryStatusInput = z.object({ status: z.enum(['accepted', 'awaiting_pickup', 'delivered']) });
export const messageInput = z.object({ recipient_id: z.string().uuid(), body: z.string().trim().min(1).max(500) });
export const ratingInput = z.object({ score: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() });
export const pushDeviceInput = z.object({
  expo_push_token: z.string().trim().min(20).max(255).regex(/^Expo\[.+\]$|^ExponentPushToken\[.+\]$/),
  platform: z.enum(['ios', 'android', 'web']),
});
export const donationIntentInput = z.object({
  meal_type_id: z.string().uuid(),
  meal_count: z.number().int().min(1).max(1000),
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
  target_type: z.enum(['general', 'request', 'charity']).default('general'),
  target_request_id: z.string().uuid().nullable().optional(),
  target_charity_id: z.string().uuid().nullable().optional(),
  payment_method: z.enum(['card', 'wallet']).default('card'),
}).superRefine((value, ctx) => {
  if (value.target_type === 'request' && !value.target_request_id) ctx.addIssue({ code: 'custom', path: ['target_request_id'], message: 'A target request is required' });
  if (value.target_type === 'charity' && !value.target_charity_id) ctx.addIssue({ code: 'custom', path: ['target_charity_id'], message: 'A target charity is required' });
  if (value.target_type !== 'request' && value.target_request_id) ctx.addIssue({ code: 'custom', path: ['target_request_id'], message: 'Target request is only valid for request donations' });
  if (value.target_type !== 'charity' && value.target_charity_id) ctx.addIssue({ code: 'custom', path: ['target_charity_id'], message: 'Target charity is only valid for charity donations' });
});
export const generalDonationInput = z.object({ amount: z.number().finite().positive().max(1_000_000), currency: z.string().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()), payment_method: z.enum(['card', 'wallet']).default('card') });
export const mealTypeUpdateInput = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  price_usd: z.number().finite().positive().max(1_000_000).optional(),
  is_active: z.boolean().optional(),
}).strict();
export const currencyRateInput = z.object({ rate: z.number().finite().positive().max(1_000_000) }).strict();
