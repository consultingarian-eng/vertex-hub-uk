/**
 * Campaign Knowledge — optional click-through micro-lessons.
 *
 * A lesson is a handful of swipeable info cards with pop-quiz checks
 * sprinkled between them (2–5 minutes each). This bundle ships EMPTY on
 * purpose — the campaign's own material lives in the playbook library
 * (backend/seed/product_knowledge_topics.json) and no quiz answers were
 * supplied with it. Add lessons to LESSONS below and the Campaign Knowledge
 * hub, the lesson player and the trainee journey milestone pick them up.
 * With no lessons, the hub shows the playbook and the final exam (both
 * served from the backend's product-knowledge collections).
 */

export type InfoCard = {
  kind: 'info';
  title: string;
  /** Short, punchy bullets — the things worth remembering. */
  points: string[];
  /** Optional door-ready line — how you'd actually say it to a customer. */
  sayIt?: string;
};

export type QuizCard = {
  kind: 'quiz';
  question: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
};

export type LessonCard = InfoCard | QuizCard;

export type Lesson = {
  id: string;
  title: string;
  subtitle: string;
  icon: string;        // Ionicons name
  minutes: number;     // honest completion estimate
  cards: LessonCard[];
};

export const LESSONS: Lesson[] = [];

export const TOTAL_QUIZZES = LESSONS.reduce(
  (n, l) => n + l.cards.filter((c) => c.kind === 'quiz').length,
  0,
);
export const TOTAL_MINUTES = LESSONS.reduce((n, l) => n + l.minutes, 0);
