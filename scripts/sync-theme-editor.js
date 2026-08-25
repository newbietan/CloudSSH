const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const themeSourcePath = path.join(rootDir, 'frontend', 'src', 'theme.ts');
const editorPath = path.join(rootDir, 'docs', 'theme-editor', 'index.html');

const themeSource = fs.readFileSync(themeSourcePath, 'utf8');
let editorHtml = fs.readFileSync(editorPath, 'utf8');

const terminalThemes = readObjectLiteral(themeSource, 'export const THEMES =');
const uiThemes = readObjectLiteral(themeSource, 'export const UI_THEMES:');
const stylePresets = readObjectLiteral(themeSource, 'export const UI_STYLE_PRESETS:');
const builtInAppearances = readObjectLiteral(themeSource, 'export const BUILT_IN_APPEARANCE:');
const colorSchemes = readObjectLiteral(themeSource, 'const COLOR_SCHEMES:');
const labels = {
  'standard-dark': 'Standard Dark',
  'standard-light': 'Standard Light',
  cyberpunk: 'Cyberpunk',
  glacier: 'Glacier',
  gruvbox: 'Gruvbox',
};

const presets = Object.fromEntries(
  Object.keys(terminalThemes).map((themeName) => {
    const appearance = builtInAppearances[themeName] || {};
    const style = appearance.style || 'cyberpunk';
    const stylePreset = stylePresets[style] || stylePresets.cyberpunk;
    return [
      themeName,
      {
        name: labels[themeName] || themeName,
        colorScheme: colorSchemes[themeName],
        appearance: {
          ...stylePreset,
          ...appearance,
          components: {
            ...stylePreset.components,
            ...(appearance.components || {}),
          },
        },
        terminal: terminalThemes[themeName],
        ui: uiThemes[themeName],
      },
    ];
  }),
);

const generatedBlock = `const PRESETS = /* THEME_PRESETS_START */ ${JSON.stringify(presets, null, 2)} /* THEME_PRESETS_END */;`;
const markerStart = editorHtml.indexOf('/* THEME_PRESETS_START */');
const markerEnd = editorHtml.indexOf('/* THEME_PRESETS_END */');

if (markerStart >= 0 && markerEnd > markerStart) {
  const declarationStart = editorHtml.lastIndexOf('const PRESETS =', markerStart);
  const declarationEnd = editorHtml.indexOf(';', markerEnd);
  editorHtml = `${editorHtml.slice(0, declarationStart)}${generatedBlock}${editorHtml.slice(declarationEnd + 1)}`;
} else {
  const declarationStart = editorHtml.indexOf('const PRESETS =');
  if (declarationStart < 0) throw new Error('Could not find PRESETS declaration in theme editor');
  const objectStart = editorHtml.indexOf('{', declarationStart);
  const objectEnd = findMatchingBrace(editorHtml, objectStart);
  const declarationEnd = editorHtml.indexOf(';', objectEnd);
  editorHtml = `${editorHtml.slice(0, declarationStart)}${generatedBlock}${editorHtml.slice(declarationEnd + 1)}`;
}

fs.writeFileSync(editorPath, editorHtml, 'utf8');
console.log('Theme editor presets synchronized from frontend/src/theme.ts');

function readObjectLiteral(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find ${marker}`);
  const objectStart = source.indexOf('{', markerIndex + marker.length);
  const objectEnd = findMatchingBrace(source, objectStart);
  const literal = source.slice(objectStart, objectEnd + 1);
  // 仓库源码属于受信任输入；这里只执行抽取出的纯数据对象，供静态 Pages 使用。
  // pi-lens-ignore: no-global-eval-js
  return Function(`"use strict"; return (${literal});`)();
}

function findMatchingBrace(source, startIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = startIndex; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}') {
      depth--;
      if (depth === 0) return index;
    }
  }
  throw new Error('Unterminated object literal');
}
