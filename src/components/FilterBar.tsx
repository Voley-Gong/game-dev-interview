import { useState } from 'react';

interface FilterBarProps {
  tags: string[];
  activeLevel: number | null;
  activeTag: string | null;
  onLevelChange: (level: number | null) => void;
  onTagChange: (tag: string | null) => void;
}

const levelLabels: Record<number, string> = {
  1: '📗 基础',
  2: '📘 进阶',
  3: '📕 架构',
  4: '📙 深度',
};

export default function FilterBar({
  tags,
  activeLevel,
  activeTag,
  onLevelChange,
  onTagChange,
}: FilterBarProps) {
  return (
    <div class="filter-bar">
      <span style={{ fontSize: '13px', color: 'var(--text-muted)', marginRight: '4px' }}>
        难度：
      </span>
      {[1, 2, 3, 4].map((lv) => (
        <button
          key={lv}
          class={`filter-chip ${activeLevel === lv ? 'active' : ''}`}
          onClick={() => onLevelChange(activeLevel === lv ? null : lv)}
        >
          {levelLabels[lv]}
        </button>
      ))}
      {tags.length > 0 && (
        <>
          <span style={{ fontSize: '13px', color: 'var(--text-muted)', marginLeft: '12px', marginRight: '4px' }}>
            标签：
          </span>
          {tags.map((tag) => (
            <button
              key={tag}
              class={`filter-chip ${activeTag === tag ? 'active' : ''}`}
              onClick={() => onTagChange(activeTag === tag ? null : tag)}
            >
              {tag}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
