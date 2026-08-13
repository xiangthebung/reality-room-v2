import { readFileSync, globSync } from 'node:fs';
import { transform } from 'esbuild';

/**
 * A BACKTICK INSIDE A SHADER STOPS THE APP BOOTING, AND BLAMES SOMETHING ELSE.
 *
 *   npm run check:glsl
 *
 * Every shader in this project is a JS template literal, so a backtick anywhere
 * inside one — including inside a GLSL comment, which is where it always
 * happens, because prose about uBloom wants to quote the identifier — closes the
 * template early. Everything after it is then parsed as JavaScript.
 *
 * THE BUILD ALREADY CATCHES THIS. What it does not do is say what happened: the
 * parser reports the first token that cannot follow, which is typically a GLSL
 * keyword some lines further on, and reads as "Expected ',', got 'if'" pointing
 * at a line that is perfectly fine. The warning comments stamped on individual
 * shader blocks only help whoever already knows to look for them. This is a
 * five-minute detour that has been paid repeatedly on this codebase.
 *
 * SO THIS CHECK ADDS EXACTLY ONE THING: a name for the failure. It parses each
 * file, and only when the parse FAILS does it go looking for the culprit —
 * which means it cannot produce a false positive, because a file that parses is
 * a file that builds. A first attempt tried to identify cut-short templates by
 * inspecting what followed them, and reported 27 problems in a tree that built
 * perfectly, for the obvious reason that a vertex shader is very often followed
 * by a fragment shader. Deferring to the parser is the whole design.
 */

const FILES = globSync('src/**/*.js');
/** Lines that are GLSL prose: a comment, inside something that looks like a shader. */
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

let bad = 0;
let broken = 0;

for (const file of FILES) {
  const src = readFileSync(file, 'utf8');
  try {
    await transform(src, { loader: 'js', sourcemap: false });
    continue;
  } catch {
    broken++;
  }

  /**
   * The file does not parse. The overwhelmingly likely cause here is a backtick
   * in a shader comment, so look for one and name it. Reported in file order
   * because the FIRST such backtick is the one that closed the template; the
   * ones after it are inside what the parser now thinks is JavaScript.
   */
  const lines = src.split('\n');
  const suspects = [];
  for (let i = 0; i < lines.length; i++) {
    if (!COMMENT.test(lines[i])) continue;
    if (!lines[i].includes('`')) continue;
    suspects.push({ line: i + 1, text: lines[i].trim() });
  }

  console.log(`\n  ${file} does not parse.`);
  if (suspects.length === 0) {
    console.log(`    No backtick found in a comment — this is some other syntax error.`);
    console.log(`    Run the build for the parser's own message.`);
  } else {
    for (const s of suspects) {
      console.log(`    line ${s.line}: ${s.text.slice(0, 96)}`);
    }
    console.log(
      `    ^ a backtick in a comment closes the shader template it sits in.\n` +
        `      Backticks are not legal inside a shader here, not even in a GLSL comment.\n` +
        `      Write the identifier bare, or in CAPITALS, as the surrounding blocks do.`
    );
    bad++;
  }
}

console.log(`\n  ${FILES.length} files parsed`);
if (broken) {
  console.log(`\nFAIL: ${broken} file(s) do not parse${bad ? `, ${bad} of them from a backtick in a shader comment` : ''}.`);
  process.exit(1);
}
console.log('\nPASS: every file parses; no shader template is closed early by a stray backtick.');
