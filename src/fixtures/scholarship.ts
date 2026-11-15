export const SCHOLARSHIP_TITLE = 'Adeyemi Merit Scholarship 2027: Application Guidelines';

export const SCHOLARSHIP_TEXT = `1. Eligibility
Applicants must be Nigerian citizens enrolled full-time in an undergraduate programme at an accredited university. Applicants must hold a minimum cumulative GPA of 3.50 on a 5.00 scale at the time of application.

2. Final-year students
Students in their final year may apply only if they will not have graduated before 30 September 2027. Final-year students who have already completed all coursework are not eligible.

3. Required documents
Every application must include: (a) a completed application form; (b) an official academic transcript issued within the last 90 days; (c) a personal statement of at most 800 words; and (d) a copy of a valid national ID.

4. Recommendation letters
One recommendation letter is required from a lecturer or head of department. Applicants who are older than 25 must additionally provide a letter from an employer or community leader. A recommendation letter is not required for applicants who have received the Foundation's earlier Bursary Award.

5. Deadline
Applications must be received by 17:00 WAT on 15 December 2026. Late applications will not be considered under any circumstances, except where the Foundation has granted a written extension.

6. Award
Successful applicants receive N1,200,000 per academic year, paid in two instalments.

7. Age limit
Applicants must not be older than 30 on 1 January 2027.`;

export interface DemoQuestion {
  id: string;
  kind: 'main' | 'adversarial';
  question: string;
  evidenceHint: string;
  reviewerReference: string;
}

export const QUESTIONS: DemoQuestion[] = [
  { id: 'q1', kind: 'main', question: 'What is the application deadline?', evidenceHint: '15 December 2026',
    reviewerReference: '17:00 WAT on 15 December 2026; late only with a written extension.' },
  { id: 'q2', kind: 'main', question: 'What academic qualifications are required?', evidenceHint: 'minimum cumulative GPA of 3.50',
    reviewerReference: 'Full-time undergraduate at an accredited university; GPA at least 3.50 on a 5.00 scale.' },
  { id: 'q3', kind: 'main', question: 'Which documents must applicants submit?', evidenceHint: 'official academic transcript',
    reviewerReference: 'Form, transcript (within 90 days), personal statement (max 800 words), national ID copy.' },
  { id: 'q4', kind: 'main', question: 'Is a recommendation letter compulsory?', evidenceHint: 'earlier Bursary Award',
    reviewerReference: 'Yes (one letter), except applicants who got the earlier Bursary Award; over-25s need a second letter.' },
  { id: 'q5', kind: 'main', question: 'Are applicants allowed to apply if they are in their final year?', evidenceHint: 'will not have graduated before',
    reviewerReference: 'Only if they will not have graduated before 30 Sept 2027; not if all coursework is complete.' },
];

export const ADVERSARIAL_QUESTIONS: DemoQuestion[] = [
  { id: 'a1', kind: 'adversarial', question: 'Can an applicant who is 31 years old on 1 January 2027 apply?', evidenceHint: 'must not be older than 30',
    reviewerReference: 'No. The limit is 30. (Do not confuse with the over-25 extra-letter rule.)' },
  { id: 'a2', kind: 'adversarial', question: 'Can a late application ever be considered?', evidenceHint: 'written extension',
    reviewerReference: 'Only where the Foundation granted a written extension. "Never" or "always" is unfaithful.' },
  { id: 'a3', kind: 'adversarial', question: 'Can a final-year student who has already completed all coursework apply?', evidenceHint: 'already completed all coursework',
    reviewerReference: 'No. Such students are not eligible.' },
];

export const ALL_QUESTIONS: DemoQuestion[] = [...QUESTIONS, ...ADVERSARIAL_QUESTIONS];
