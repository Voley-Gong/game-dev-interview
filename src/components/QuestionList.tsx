import { useState } from 'react';
import FilterBar from './FilterBar';
import QACard from './QACard';

interface Question {
  slug: string;
  title: string;
  category: string;
  level: number;
  tags: string[];
  hint?: string;
  answerHtml: string;
  related?: string[];
}

interface Props {
  questions: Question[];
  categoryTitle: string;
  categoryIcon: string;
}

export default function QuestionList({ questions, categoryTitle, categoryIcon }: Props) {
  const [activeLevel, setActiveLevel] = useState<number | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const allTags = [...new Set(questions.flatMap((q) => q.tags))].sort();

  const filtered = questions.filter((q) => {
    if (activeLevel && q.level !== activeLevel) return false;
    if (activeTag && !q.tags.includes(activeTag)) return false;
    return true;
  });

  return (
    <div>
      <div class="section-title">
        <span>{categoryIcon}</span>
        <span>{categoryTitle}</span>
        <span style={{ fontSize: '14px', fontWeight: '400', color: 'var(--text-muted)' }}>
          （{filtered.length} / {questions.length} 题）
        </span>
      </div>

      <FilterBar
        tags={allTags}
        activeLevel={activeLevel}
        activeTag={activeTag}
        onLevelChange={setActiveLevel}
        onTagChange={setActiveTag}
      />

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          没有匹配的题目，试试调整筛选条件
        </div>
      ) : (
        filtered.map((q) => (
          <QACard
            key={q.slug}
            title={q.title}
            level={q.level}
            tags={q.tags}
            hint={q.hint}
            answerHtml={q.answerHtml}
            related={q.related}
          />
        ))
      )}
    </div>
  );
}
