import { getGenerativeModel, InferenceMode, type AI, type HybridParams } from 'firebase/ai';
import { observeInferenceSource } from '../../core/report';
import { CLAIM_SCHEMA, SYSTEM_PROMPT } from '../../phase1/prompt';
import type { LocalAnswerPort } from '../domain/ports';

type OnDeviceParams = NonNullable<HybridParams['onDeviceParams']>;

export function createNanoLocalPort(ai: AI): LocalAnswerPort {
  const onDeviceParams = {
    createOptions: {
      expectedInputs: [{ type: 'text' as const, languages: ['en'] }],
      expectedOutputs: [{ type: 'text' as const, languages: ['en'] }],
      initialPrompts: [{ role: 'system' as const, content: [{ type: 'text' as const, value: SYSTEM_PROMPT }] }],
    },
    promptOptions: { responseConstraint: CLAIM_SCHEMA },
  } satisfies OnDeviceParams;
  const model = getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE, onDeviceParams });
  return {
    async init(onProgress) {
      await model.initializeDeviceModel((p: number) => onProgress?.(p));
    },
    async answer(prompt) {
      const result = await model.generateContent(prompt);
      // recorded exactly as the SDK reports it (absent stays absent); never inferred
      return { rawText: result.response.text(), inferenceSource: observeInferenceSource(result.response.inferenceSource) };
    },
  };
}
