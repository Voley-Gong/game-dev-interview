import { useState, useRef, useEffect } from 'react';

interface Props {
  title: string;
  level: number;
  tags: string[];
  hint?: string;
  answerHtml: string;
  related?: string[];
}

const levelLabels: Record<number, string> = {
  1: '📗 基础',
  2: '📘 进阶',
  3: '📕 架构',
  4: '📙 深度',
};

export default function QACard({ title, level, tags, hint, answerHtml, related }: Props) {
  const [open, setOpen] = useState(false);
  const answerRef = useRef<HTMLDivElement>(null);

  return (
    <div class="qa-card" data-pagefind-body>
      <div class="qa-question" onClick={() => setOpen(!open)}>
        <div class="qa-q-text">
          <div class="qa-q-title">{title}</div>
          <div class="qa-q-meta">
            <span class="level-badge" data-level={level}>
              {levelLabels[level]}
            </span>
            {tags.map((t) => (
              <span class="tag" key={t}>{t}</span>
            ))}
          </div>
          {hint && !open && (
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '6px' }}>
              💡 {hint}
            </div>
          )}
        </div>
        <button class="qa-toggle-btn" type="button">
          {open ? '🔼 收起' : '🔽 查看'}
        </button>
      </div>
      <div
        ref={answerRef}
        class={`qa-answer ${open ? 'open' : ''}`}
        dangerouslySetInnerHTML={{ __html: answerHtml }}
      />
    </div>
  );
}
