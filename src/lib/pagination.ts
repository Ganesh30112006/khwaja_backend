export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PageWindow {
  page: number;
  pageSize: number;
  offset: number;
}

/** Clamps page/pageSize like the frontend expects: size 1–500 (default 20), page 1–last page. */
export function pageWindow(total: number, page: unknown, pageSize: unknown): PageWindow {
  const size = Math.min(Math.max(1, Math.floor(Number(pageSize)) || 20), 500);
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages);
  return { page: p, pageSize: size, offset: (p - 1) * size };
}
