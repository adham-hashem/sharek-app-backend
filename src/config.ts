import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.boolean().default(false),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  DEFAULT_CURRENCY: z.string().length(3).default('USD'),
});

export const config = schema.parse(process.env);
const defaultCorsOrigins = [
  'http://localhost:5173',
  'http://localhost:8081',
  'https://sharek-app-frontend.vercel.app',
];

export const corsOrigins = Array.from(new Set([
  ...defaultCorsOrigins,
  ...config.CORS_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean),
]));
