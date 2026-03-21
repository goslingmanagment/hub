export type ProfileSection = {
  heading: string;
  content: string;
};

export type ParsedProfile = {
  preamble: string | null;
  sections: ProfileSection[];
};

// Matches ## headings, allowing optional trailing # (ATX closing)
const H2_REGEX = /^##\s+(.+?)\s*#*\s*$/gm;

// Strips leading numeric prefixes like "1.", "03)", "1 -" from a heading for classification
function stripNumericPrefix(heading: string): string {
  return heading.replace(/^\d+[.)]\s*/, "").trim();
}

export function parseProfileSections(body: string): ParsedProfile {
  const matches = [...body.matchAll(H2_REGEX)];

  if (matches.length === 0) {
    return { preamble: body, sections: [] };
  }

  const preambleText = body.slice(0, matches[0].index).trim();
  const preamble = preambleText || null;

  const sections: ProfileSection[] = matches.map((match, i) => {
    const heading = match[1].trim();
    const contentStart = match.index + match[0].length;
    const contentEnd = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const content = body.slice(contentStart, contentEnd).trim();
    return { heading, content };
  });

  return { preamble, sections };
}

export function isStrategySection(heading: string): boolean {
  const bare = stripNumericPrefix(heading);
  return /^стратегия$/i.test(bare) || /^strategy$/i.test(bare);
}
