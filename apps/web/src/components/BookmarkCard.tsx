import { useEffect, useState } from "react";
import { TagList, LetterAvatar } from "./ui";
import { brandOf, visIcon } from "../lib/colors";

export type BmLike = {
  id: string;
  title: string;
  url: string;
  description?: string | null;
  icon?: string | null;
  visibility?: string;
  is_archived?: boolean;
  tags?: Array<string | { name: string }> | null;
};

function BmAvatar({ bm }: { bm: BmLike }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [bm.icon]);
  if (bm.icon && !broken) {
    return (
      <img
        className="bm-favicon"
        src={bm.icon}
        alt=""
        width={32}
        height={32}
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  }
  return <LetterAvatar url={bm.url} />;
}

type Props = {
  bm: BmLike;
  editMode?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  /** Batch selection (edit mode): render a checkbox overlay. */
  selected?: boolean;
  onSelectToggle?: () => void;
  /** Drag reorder (edit mode): render a top-left handle. */
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Fired when a dragged card enters this one — live-reorders the preview. */
  onDragEnterTarget?: () => void;
};

export function BookmarkCard({
  bm,
  editMode,
  onEdit,
  onDelete,
  onArchive,
  selected,
  onSelectToggle,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  onDragEnterTarget,
}: Props) {
  const b = brandOf(bm.url);
  // Show a tooltip with the full title only when the title is truncated.
  const [tipOpen, setTipOpen] = useState(false);
  const onTitleEnter = (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    setTipOpen(el.scrollWidth > el.clientWidth);
  };
  const onTitleLeave = () => setTipOpen(false);
  const body = (
    <>
      {tipOpen ? <div className="bm-title-tooltip">{bm.title}</div> : null}
      {draggable ? (
        <span className="drag-handle bm-drag-handle" aria-hidden>
          ⠿
        </span>
      ) : null}
      {onSelectToggle ? (
        <input
          type="checkbox"
          className="bm-check"
          checked={!!selected}
          aria-label={`select ${bm.title}`}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.stopPropagation();
            onSelectToggle();
          }}
        />
      ) : null}
      <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
        <BmAvatar bm={bm} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 5, flexWrap: "nowrap" }}>
            <span className="bm-title grow" onMouseEnter={onTitleEnter} onMouseLeave={onTitleLeave}>
              {bm.title}
            </span>
            {bm.visibility ? (
              <span style={{ fontSize: 10, flex: "none" }} title={bm.visibility}>
                {visIcon(bm.visibility)}
              </span>
            ) : null}
          </div>
          <div className="bm-domain">{b.domain}</div>
        </div>
      </div>
      {bm.description ? <div className="bm-desc">{bm.description}</div> : <div className="bm-desc" />}
      <div className="bm-meta">
        <TagList tags={bm.tags} />
        {editMode || onEdit || onArchive || onDelete ? (
          <div className={`bm-actions${editMode ? " always" : ""}`}>
            {onEdit ? (
              <button
                type="button"
                className="btn-icon"
                title="Edit"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onEdit();
                }}
              >
                ✎
              </button>
            ) : null}
            {onArchive ? (
              <button
                type="button"
                className="btn-icon"
                title={bm.is_archived ? "Unarchive" : "Archive"}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onArchive();
                }}
              >
                {bm.is_archived ? "📤" : "📦"}
              </button>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                className="btn-icon"
                title="Delete"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDelete();
                }}
              >
                ✕
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );

  return (
    <a
      className={`bm-card${dragging ? " dragging" : ""}`}
      href={bm.url}
      target="_blank"
      rel="noreferrer"
      data-testid={`bm-card-${bm.id}`}
      onClick={(e) => {
        if (editMode) e.preventDefault();
      }}
      draggable={draggable || undefined}
      onDragStart={
        draggable && onDragStart
          ? (e) => {
              e.dataTransfer.effectAllowed = "move";
              onDragStart();
            }
          : undefined
      }
      onDragEnd={onDragEnd}
      onDragEnter={onDragEnterTarget ? () => onDragEnterTarget() : undefined}
    >
      {body}
    </a>
  );
}
