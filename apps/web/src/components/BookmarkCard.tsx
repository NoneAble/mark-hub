import { TagList, LetterAvatar } from "./ui";
import { brandOf, visIcon } from "../lib/colors";

export type BmLike = {
  id: string;
  title: string;
  url: string;
  description?: string | null;
  visibility?: string;
  is_favorite?: boolean;
  tags?: Array<string | { name: string }> | null;
};

type Props = {
  bm: BmLike;
  editMode?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onFav?: () => void;
  onQr?: () => void;
  /** When true, card itself is not an anchor wrapper (dashboard has multi-actions). */
  linkTitleOnly?: boolean;
};

export function BookmarkCard({
  bm,
  editMode,
  onEdit,
  onDelete,
  onFav,
  onQr,
  linkTitleOnly = true,
}: Props) {
  const b = brandOf(bm.url);
  const body = (
    <>
      <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
        <LetterAvatar url={bm.url} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 5, flexWrap: "nowrap" }}>
            {linkTitleOnly ? (
              <a
                className="bm-title grow"
                href={bm.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  if (editMode) e.preventDefault();
                }}
              >
                {bm.title}
              </a>
            ) : (
              <span className="bm-title grow">{bm.title}</span>
            )}
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
        {editMode || onFav || onEdit || onQr || onDelete ? (
          <div className={`bm-actions${editMode ? " always" : ""}`}>
            {onFav ? (
              <button
                type="button"
                className="btn-icon"
                title="Favorite"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onFav();
                }}
                style={{ color: bm.is_favorite ? "var(--warn)" : undefined }}
              >
                {bm.is_favorite ? "★" : "☆"}
              </button>
            ) : null}
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
            {onQr ? (
              <button
                type="button"
                className="btn-icon"
                title="QR"
                data-testid={`qr-${bm.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onQr();
                }}
              >
                ▦
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

  if (!linkTitleOnly) {
    return (
      <a
        className="bm-card"
        href={bm.url}
        target="_blank"
        rel="noreferrer"
        data-testid={`bm-card-${bm.id}`}
        onClick={(e) => {
          if (editMode) e.preventDefault();
        }}
      >
        {body}
      </a>
    );
  }

  return (
    <div className="bm-card" data-testid={`bm-card-${bm.id}`}>
      {body}
    </div>
  );
}
