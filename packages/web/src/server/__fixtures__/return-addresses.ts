// Return addresses for the tests of every handler that redirects to one a request names
// (safeRedirect's callers). Test code only.

/** Each of these would take the browser to another site, at once or once a router decodes it: '/' instead. */
export const hostileReturns: readonly [label: string, target: string][] = [
  ['protocol-relative', '//evil.example'],
  ['three slashes', '///evil.example'],
  ['backslash', '/\\evil.example'],
  ['encoded slashes', '/%2F%2Fevil.example'],
  ['an encoded slash after one', '/%2F/evil.example'],
  ['an encoded backslash', '/%5Cevil.example'],
  ['a dot segment', '/.//evil.example'],
  ['a dot-dot segment', '/..//evil.example'],
  ['a dot-dot segment deeper down', '/a/..//evil.example'],
  ['an encoded dot segment', '/%2e//evil.example'],
  ['an encoded dot-dot segment', '/%2E%2E//evil.example'],
  ['absolute', 'https://evil.example'],
  ['a scheme', 'javascript:alert(1)'],
  ['tab', '/\t/evil.example'],
  ['an encoded tab', '/%09/evil.example'],
  ['line feed', '/\n/evil.example'],
  ['carriage return', '/\r/evil.example'],
];

/** Paths on this site, which come back exactly as given. */
export const ordinaryReturns: readonly string[] = [
  '/c/news/comments?sort=new&after=abc#comment-1',
  '/post/019a0000-0000-7000-8000-000000000001?sort=top#comments',
  // The composer's own sign-in round trip: the form's fields, escaped, in the query.
  '/submit?type=link&url=https%3A%2F%2Fexample.test%2Fa%2F%2Fb&body=one%0Atwo',
];
