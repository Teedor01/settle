import { getGenerativeModel, InferenceMode, type AI, type HybridParams } from 'firebase/ai';
import { observeInferenceSource } from '../../core/report';
import type { CloudReviewPort } from '../domain/ports';
import { REVIEW_SCHEMA } from '../domain/review';

type InCloudParams = NonNullable<HybridParams['inCloudParams']>;
export const CLOUD_REVIEW_MODEL = 'gemini-3.5-flash-lite'; // default per current Firebase web docs; change deliberately if retired

export function createCloudReviewPort(ai: AI): CloudReviewPort {
  const inCloudParams = {
    model: CLOUD_REVIEW_MODEL,
    generationConfig: { responseMimeType: 'application/json', responseSchema: REVIEW_SCHEMA },
  } satisfies InCloudParams;
  const model = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams });
  return {
    async review(prompt) {
      const result = await model.generateContent(prompt);
      return { rawText: result.response.text(), inferenceSource: observeInferenceSource(result.response.inferenceSource), model: CLOUD_REVIEW_MODEL };
    },
  };
}
