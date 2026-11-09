// Claude generates the three card types that need linguistic judgment rather
// than lookup: Contrast, Situation and Naturalness - plus an English gloss of
// the mined sentence when no reference subtitle track is loaded.
//
// Everything else in this app works offline. If ANTHROPIC_API_KEY is unset,
// these types are simply unavailable and the UI says so.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { getApiKey } from './settings.mjs';

export const MODEL = 'claude-opus-5-5';

export const llmAvailable = () => Boolean(getApiKey() || process.env.ANTHROPIC_AUTH_TOKEN);

let client = null;
let clientKey = null;
const getClient = () => {
  const key = getApiKey();
  if (!client || clientKey !== key) {
    // The user is waiting on a card preview: fail in about a minute rather than the SDK's 10.
    const opts = { timeout: 60_000, maxRetries: 2 };
    client = new Anthropic(key ? { ...opts, apiKey: key } : opts);
    clientKey = key;
  }
  return client;
};

/** Turn an SDK failure into a sentence the card dialog can show. */
function friendly(e) {
  const say = (msg) => Object.assign(new Error(msg, { cause: e }), { status: e.status });
  if (e instanceof Anthropic.AuthenticationError) return say('Claude rejected the API key - check it in Settings');
  if (e instanceof Anthropic.PermissionDeniedError) return say('This API key is not allowed to use Claude Opus 5.5');
  if (e instanceof Anthropic.RateLimitError) return say('Claude is rate-limiting this key - wait a minute and try again');
  if (e instanceof Anthropic.APIConnectionTimeoutError) return say('Claude took too long to answer - try again');
  if (e instanceof Anthropic.APIConnectionError) return say('Cannot reach Claude - check your internet connection');
  if (e instanceof Anthropic.InternalServerError) return say('Claude is temporarily unavailable - try again shortly');
  if (e instanceof Anthropic.BadRequestError) return say(`Claude rejected the request: ${e.message}`);
  if (e instanceof Anthropic.APIError) return say(`Claude API error${e.status ? ` ${e.status}` : ''}: ${e.message}`);
  // messages.parse throws a plain AnthropicError when the text does not match the schema.
  return say(`Claude returned output that did not fit the card format: ${e.message}`);
}

const SHAPES = {
  translation: z
    .string()
    .describe('Natural English translation of the whole sentence. No quotes, no notes.'),

  contrast: z
    .object({
      question: z
        .string()
        .describe(
          'A forced-choice question in Japanese testing the decision boundary between the ' +
            'target word and its closest confusable. Either "Which sounds more natural?" with ' +
            'two full sentences, or one sentence with a ____ blank. Write the question stem only.'
        ),
      optionA: z.string().describe('Option A, in Japanese.'),
      optionB: z.string().describe('Option B, in Japanese.'),
      answer: z.string().describe('The correct option, repeated verbatim (not "A" or "B").'),
      explanation: z
        .string()
        .describe('One sentence in English on why the other option is wrong. Name the boundary.'),
    })
    .describe('A contrast card built around the target word and its nearest confusable.'),

  situation: z
    .object({
      situation: z
        .string()
        .describe(
          'A concrete 1-2 sentence situation in English, ending in a prompt to say something. ' +
            'Never mention the Japanese word or translate it.'
        ),
      sentence: z.string().describe('What a native speaker would actually say, in Japanese, using the target word.'),
      reading: z.string().describe('Kana reading of that sentence.'),
    })
    .describe('A situation card: the learner produces the line from the circumstances alone.'),

  naturalness: z
    .object({
      candidate: z
        .string()
        .describe(
          'A plausible-but-questionable Japanese sentence using the target word - the kind of ' +
            'mistake a learner who only knows the dictionary gloss would make. May also be fully natural.'
        ),
      verdict: z.string().describe('Exactly one of: 自然 / 不自然 / 場合による'),
      better: z.string().describe('The sentence a native would say instead. Empty string if the candidate is already natural.'),
      explanation: z.string().describe('One sentence in English explaining the judgment.'),
    })
    .describe('A "would a Japanese person say this?" card.'),
};

const SYSTEM = `You build Japanese sentence-mining flashcards for an advanced learner who is
immersing in native media. They already know the dictionary gloss of the target word - what they
lack is the decision boundary between it and its neighbours, and the situations that select it.

Rules:
- Use natural, spoken-register Japanese. Match the register of the source sentence.
- Confusables must be genuinely confusable: near-synonyms, same reading, or shared kanji.
  Never invent a contrast that no learner would actually get wrong.
- Never explain the target word's meaning in the question half of a card.
- Keep every English string to one sentence.`;

/**
 * One request covers every LLM-backed field the caller asked for, so mining a
 * word with three generative card types costs one round trip.
 *
 * @param {{sentence:string, word:string, reading:string, gloss:string, need:string[]}} ctx
 */
export async function enrich({ sentence, word, reading, gloss, need }) {
  const wanted = need.filter((k) => k in SHAPES);
  if (!wanted.length) return {};
  if (!llmAvailable()) throw new Error('ANTHROPIC_API_KEY is not set - LLM card types unavailable');

  const shape = Object.fromEntries(wanted.map((k) => [k, SHAPES[k]]));

  let response;
  try {
    response = await getClient().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      // Opus 5.5 defaults to medium; set it so a model change cannot silently shift cost or quality.
      output_config: { effort: 'medium', format: betaZodOutputFormat(z.object(shape)) },
      // A policy decline is re-run server-side on Anthropic's recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [
        {
          role: 'user',
          content: [
            `Target word: ${word}${reading ? `（${reading}）` : ''}`,
            `Dictionary gloss: ${gloss}`,
            `Mined from this line: ${sentence}`,
            '',
            `Produce: ${wanted.join(', ')}.`,
          ].join('\n'),
        },
      ],
    });
  } catch (e) {
    throw friendly(e);
  }

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to write cards for this line');
  if (response.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before finishing the cards - try again');
  if (!response.parsed_output) throw new Error('Claude returned no parseable output');
  return response.parsed_output;
}

export const LLM_FIELDS = Object.keys(SHAPES);
