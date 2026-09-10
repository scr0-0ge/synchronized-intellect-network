const credentialHeaderNames =
  "(?:authorization|proxy-authorization|api-key|x-api-key|x-auth-token|x-access-token|cookie|set-cookie)";

const quotedCredentialHeader = new RegExp(
  `(["'])(${credentialHeaderNames}\\s*:)[\\s\\S]*?\\1`,
  "giu",
);
const unquotedCredentialHeader = new RegExp(
  `(\\b${credentialHeaderNames}\\s*:\\s*)(?:(?:bearer|basic|token|apikey)\\s+)?[^\\s"';&|]+`,
  "giu",
);
const ghTokenArgument =
  /(^|[\s;&|])(gh(?:\.exe)?\s+auth\s+login\b[^;&|\r\n]*?--with-token)(\s+)(?:"[^"]*"|'[^']*'|(?!-)[^\s"';&|]+)/giu;
const curlUserInfoFlag =
  /(^|[\s;&|])(curl(?:\.exe)?\b[^;&|\r\n]*?\s(?:-u|--user))(\s*=\s*|\s+)(?:"[^"]*:[^"]*"|'[^']*:[^']*'|[^\s"';&|]+:[^\s"';&|]+)/giu;
const shortPasswordFlag =
  /(^|[\s;&|])((?:docker\s+login|az\s+login)\b[^;&|\r\n]*?\s-p)(\s+)(?:"[^"]*"|'[^']*'|[^\s"';&|]+)/giu;
const attachedMysqlPassword =
  /(^|[\s;&|])(mysql(?:\.exe)?\b[^;&|\r\n]*?\s-p)(?:"[^"]*"|'[^']*'|[^\s"';&|]+)/giu;
const positionalCredentialValue =
  /(^|[\s;&|])((?:aws(?:\.exe)?\s+configure\s+set\s+(?:aws_secret_access_key|aws_access_key_id|aws_session_token)|npm(?:\.cmd|\.exe)?\s+config\s+set\s+(?:(?:\/\/[^\s;&|]+:)?_authToken)))(\s+)(?:"[^"]*"|'[^']*'|[^\s"';&|]+)/giu;
const credentialFlag =
  /(^|[\s;&|])(--?(?:api[-_]?key|auth(?:orization)?|auth[-_]?token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|token|password|passwd|secret|credentials?))(\s*=\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s"';&|]+)/giu;
const credentialEnvironmentAssignment =
  /(^|[\s;&|=])((?:\$env:)?(?:[A-Za-z][A-Za-z0-9_]*_)?(?:api_key|apikey|access_key|secret_key|private_key|auth|authorization|token|auth_token|access_token|refresh_token|secret|client_secret|password|passwd|credentials?))(\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"';&|]+)/giu;
const credentialUrlUserInfo = /(:\/\/)[^/\s:@]+:[^@\s/]+@/gu;

/** Replaces recognizable command-line credential values before display truncation. */
export function redactToolActivityCredentials(value: string): string {
  return value
    .replace(
      quotedCredentialHeader,
      (_match, quote: string, header: string) =>
        `${quote}${header} <redacted>${quote}`,
    )
    .replace(unquotedCredentialHeader, "$1<redacted>")
    .replace(ghTokenArgument, "$1$2$3<redacted>")
    .replace(curlUserInfoFlag, "$1$2$3<redacted>")
    .replace(shortPasswordFlag, "$1$2$3<redacted>")
    .replace(attachedMysqlPassword, "$1$2<redacted>")
    .replace(positionalCredentialValue, "$1$2$3<redacted>")
    .replace(
      credentialFlag,
      (_match, boundary: string, flag: string, separator: string) =>
        `${boundary}${flag}${separator}<redacted>`,
    )
    .replace(
      credentialEnvironmentAssignment,
      (_match, boundary: string, name: string, separator: string) =>
        `${boundary}${name}${separator}<redacted>`,
    )
    .replace(credentialUrlUserInfo, "$1<redacted>@");
}
