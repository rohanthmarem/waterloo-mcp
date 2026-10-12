/** Limit browser-cookie reads to a file in the requested LEARN course. */
export function courseFilePath(baseUrl: string, courseId: number, input: string): string {
  const base = new URL(baseUrl);
  const url = new URL(input, base);
  if (!Number.isSafeInteger(courseId) || courseId <= 0 || url.origin !== base.origin ||
      url.username || url.password || /[\\\x00-\x20]/.test(input)) {
    throw new Error("INVALID_COURSE_FILE_URL: use a LEARN content/enforced URL in the requested course.");
  }
  // Reject escaped separators and double escaping before comparing directory names.
  if (/%(?:2f|5c|25|00)/i.test(url.pathname)) {
    throw new Error("INVALID_COURSE_FILE_URL: encoded path separators are not supported.");
  }
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch {
    throw new Error("INVALID_COURSE_FILE_URL: invalid URL encoding.");
  }
  if (/[\\\x00-\x1f]/.test(pathname) || !pathname.startsWith(`/content/enforced/${courseId}-`) ||
      !/^\/content\/enforced\/[^/]+\/.+/.test(pathname) ||
      pathname.split("/").some(part => part === "." || part === "..")) {
    throw new Error("INVALID_COURSE_FILE_URL: file must belong to the requested course.");
  }
  // Course file links require no other query parameters. Avoid action endpoints.
  for (const key of url.searchParams.keys()) {
    if (key !== "isCourseFile") throw new Error("INVALID_COURSE_FILE_URL: unsupported query parameter.");
  }
  return url.pathname + url.search;
}
