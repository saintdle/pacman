const DEFAULT_MAX_PAGE_SIZE = 100;

export function getListOptions(req, defaultPageSize) {
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined || req.query.includeSimulated !== undefined;
  const parsedPage = Number.parseInt(req.query.page, 10);
  const parsedPageSize = Number.parseInt(req.query.pageSize, 10);
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const pageSize = Number.isInteger(parsedPageSize) && parsedPageSize > 0
    ? Math.min(parsedPageSize, DEFAULT_MAX_PAGE_SIZE)
    : defaultPageSize;
  const includeSimulated = req.query.includeSimulated !== 'false';

  return { hasPagination, page, pageSize, includeSimulated };
}

export function paginate(items, { page, pageSize }) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    page: currentPage,
    pageSize,
    total,
    totalPages,
  };
}
