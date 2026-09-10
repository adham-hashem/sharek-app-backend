import type { FastifyReply, FastifyRequest } from 'fastify';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from './config.js';

export function userClient(accessToken: string): SupabaseClient {
  return createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: WebSocket as any },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) {
    await reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authentication is required' });
    return;
  }
  const client = userClient(token);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    await reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid or expired access token' });
    return;
  }
  request.user = data.user;
  request.supabase = client;
}

export function isAdmin(user: User): boolean {
  return user.app_metadata?.is_admin === true || user.app_metadata?.role === 'admin';
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user || !request.supabase) await requireUser(request, reply);
  if (reply.sent) return;
  if (!isAdmin(request.user)) await reply.code(403).send({ error: 'FORBIDDEN', message: 'Administrator access is required' });
}
