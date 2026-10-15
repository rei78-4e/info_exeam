export interface Option {
  id: string;
  text: string;
}

export interface Question {
  id: string;
  field: string;
  prompt: string;
  options: Option[];
  answer: string;
  explanation: string;
}

export interface QuestionSet {
  set_id: string;
  title: string;
  questions: Question[];
}

export const EVENT_TYPES = ['view', 'leave', 'select', 'confidence', 'finish'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const CONFIDENCES = ['sure', 'unsure', 'guess'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export interface QuizEvent {
  seq: number;
  question_id: string | null;
  type: EventType;
  value: string | null;
  ts: number;
}

export interface PathStep {
  answer: string;
  /** その問題に滞在した累計時間（選択した時点）ms */
  at_ms: number;
}

export interface QuestionResult {
  question_id: string;
  position: number;
  field: string;
  first_answer: string | null;
  final_answer: string | null;
  correct_answer: string;
  is_correct: boolean;
  change_count: number;
  confidence: Confidence | null;
  dwell_ms: number;
  path: PathStep[];
}
