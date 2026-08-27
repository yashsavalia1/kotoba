// Claude generates the three card types that need linguistic judgment rather
// than lookup: Contrast, Situation and Naturalness - plus an English gloss of
// the mined sentence when no reference subtitle track is loaded.
//
// Everything else in this app works offline. If ANTHROPIC_API_KEY is unset,
// these types are simply unavailable and the UI says so.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

export const llmAvailable = () =>
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client;
const getClient = () => (client ??= new Anthropic());

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

  const response = await getClient().messages.parse({
    model: 'claude-opus-5',
    max_tokens: 4000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
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
    output_config: { format: zodOutputFormat(z.object(shape)) },
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined this request');
  if (!response.parsed_output) throw new Error('Claude returned no parseable output');
  return response.parsed_output;
}

export const LLM_FIELDS = Object.keys(SHAPES);
