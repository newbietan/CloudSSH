const fs = require('node:fs');
const path = require('node:path');

const LOCAL_FONT_FILES = ['material-symbols-outlined-subset.woff2', 'jetbrains-mono.woff2'];

/** Fail before writing Worker HTML if a required font would need an unserved asset route. */
function assertInlinedFonts(css, assetNames, fontsDir) {
  if (assetNames.some((name) => /\.(?:woff2?|ttf|otf)$/i.test(name))) {
    throw new Error('Worker fonts must be inlined; standalone font assets cannot be served.');
  }
  for (const filename of LOCAL_FONT_FILES) {
    const base64 = fs.readFileSync(path.join(fontsDir, filename)).toString('base64');
    if (!css.includes(`data:font/woff2;base64,${base64}`)) {
      throw new Error(`Required font was not inlined completely: ${filename}`);
    }
  }
  for (const face of css.matchAll(/@font-face\s*\{[^}]*\}/gi)) {
    for (const url of face[0].matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
      if (!url[2].startsWith('data:font/woff2;base64,')) {
        throw new Error('Worker font-face URLs must use inlined WOFF2 data.');
      }
    }
  }
  if (/fonts\.(?:googleapis|gstatic)\.com/i.test(css)) {
    throw new Error('Worker CSS must not depend on Google Fonts.');
  }
}

module.exports = { assertInlinedFonts, LOCAL_FONT_FILES };
