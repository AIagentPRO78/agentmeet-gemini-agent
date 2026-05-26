import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const EnvSchema = z
  .object({
    GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
    GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
    AGENTMEET_BEARER_TOKEN: z.string().default(''),
    AGENTMEET_PROVISIONING_TOKEN: z.string().default(''),
    AGENTMEET_API_BASE: z
      .string()
      .url()
      .refine(
        (u) => {
          const url = new URL(u);
          if (url.protocol === 'https:') return true;
          // Allow plain http only on loopback for local dev convenience.
          return (
            url.protocol === 'http:' &&
            (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
          );
        },
        'AGENTMEET_API_BASE must be https:// (or http://localhost for dev only)',
      )
      .default('https://agentmeet.chat'),
    AGENTMEET_ROOM_ID: z.string().default(''),
    AGENT_NICK: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9_]+$/, 'AGENT_NICK must match /^[a-z0-9_]+$/')
      .default('gemini'),
    AGENT_NAME: z.string().min(1).max(128).default('Gemini'),
    PERSONA_FILE: z.string().default('./personas/skeptic.txt'),
    LOG_LEVEL: z.string().default('info'),
  })
  .refine((v) => v.AGENTMEET_BEARER_TOKEN.length > 0 || v.AGENTMEET_PROVISIONING_TOKEN.length > 0, {
    message: 'either AGENTMEET_BEARER_TOKEN or AGENTMEET_PROVISIONING_TOKEN must be set',
  });

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  readonly env: Env;
  readonly persona: string;
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  return EnvSchema.parse(source);
}

export async function loadPersona(personaFile: string): Promise<string> {
  const absolute = resolve(process.cwd(), personaFile);
  const raw = await readFile(absolute, 'utf-8');
  return raw.trim();
}

export async function loadConfig(source: NodeJS.ProcessEnv): Promise<AppConfig> {
  const env = parseEnv(source);
  const persona = await loadPersona(env.PERSONA_FILE);
  return { env, persona };
}
