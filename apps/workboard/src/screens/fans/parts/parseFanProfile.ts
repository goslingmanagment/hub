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

export function parseProfileSections(body: string): ParsedProfile {
  const matches = [...body.matchAll(H2_REGEX)];
  const [firstMatch] = matches;

  if (firstMatch === undefined) {
    return { preamble: body, sections: [] };
  }

  const preambleText = body.slice(0, firstMatch.index).trim();
  const preamble = preambleText || null;

  const sections: ProfileSection[] = matches.map((match, i) => {
    const capturedHeading = match[1];
    if (capturedHeading === undefined) throw new Error("Profile heading pattern did not capture a heading");
    const heading = capturedHeading.trim();
    const contentStart = match.index + match[0].length;
    const contentEnd = matches[i + 1]?.index ?? body.length;
    const content = body.slice(contentStart, contentEnd).trim();
    return { heading, content };
  });

  return { preamble, sections };
}
