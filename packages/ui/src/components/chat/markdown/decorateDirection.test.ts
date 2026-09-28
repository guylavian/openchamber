import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { decorateMarkdown, type DecorateContext } from './decorate';

const window = new Window();
Object.assign(globalThis, { document: window.document, Node: window.Node, HTMLElement: window.HTMLElement });

const ctx: DecorateContext = {
  labels: {
    copy: 'Copy',
    copied: 'Copied',
    enableCodeWrap: 'Enable code wrap',
    disableCodeWrap: 'Disable code wrap',
    copyTable: 'Copy table',
    downloadTable: 'Download table',
    copyDiagram: 'Copy diagram',
    downloadDiagram: 'Download diagram',
    zoomInDiagram: 'Zoom in',
    zoomOutDiagram: 'Zoom out',
    resetDiagramView: 'Reset view',
    previewLabel: 'Preview',
    previewTitle: 'Preview',
  },
  mermaidControls: { download: false, copy: false, showPanZoomControls: false },
  codeBlockLineWrap: false,
  renderMermaid: () => ({}),
};

/** One rendered markdown block: the wrapper the renderer puts HTML into. */
const decorateBlock = (html: string): HTMLElement => {
  const block = document.createElement('div');
  block.setAttribute('data-md-block', '');
  block.setAttribute('dir', 'auto');
  block.style.display = 'contents';
  block.innerHTML = html;
  decorateMarkdown(block, ctx);
  return block;
};

const dirsOfTopLevel = (block: HTMLElement): Array<string | null> =>
  Array.from(block.children).map((child) => child.getAttribute('dir'));

describe('per-block content direction', () => {
  test('stamps dir="auto" on the top-level elements of a block', () => {
    const block = decorateBlock('<p>שלום עולם</p><h2>כותרת</h2><ul><li>פריט</li></ul>');

    expect(dirsOfTopLevel(block)).toEqual(['auto', 'auto', 'auto']);
  });

  test('leaves nested elements untagged so their text still resolves the parent', () => {
    // A container in the auto state ignores the text of descendants that are
    // themselves in the auto state. Tagging these inner nodes would leave the
    // blockquote and the list with no strong characters of their own, and both
    // would fall back to LTR.
    const block = decorateBlock(
      '<blockquote><p>ציטוט</p></blockquote>'
      + '<ol><li><p>שלב ראשון</p></li><li><p>שלב שני</p></li></ol>',
    );
    const quoteParagraph = block.querySelector('blockquote > p');
    const looseItemParagraph = block.querySelector('ol > li > p');
    const nestedList = decorateBlock('<ul><li>אחד<ul><li>מקונן</li></ul></li></ul>')
      .querySelector('li > ul');

    expect(dirsOfTopLevel(block)).toEqual(['auto', 'auto']);
    expect(quoteParagraph?.getAttribute('dir')).toBeNull();
    expect(looseItemParagraph?.getAttribute('dir')).toBeNull();
    expect(nestedList?.getAttribute('dir')).toBeNull();
  });

  test('skips code, which CSS forces left-to-right', () => {
    expect(dirsOfTopLevel(decorateBlock('<pre><code>npm test</code></pre>'))).toEqual([null]);
  });

  test('skips the code-block card so a Hebrew comment cannot flip the chrome', () => {
    const block = decorateBlock('<pre><code class="language-bash"># בדיקה\nbun test</code></pre>');
    const card = block.querySelector('[data-component="markdown-code"]');

    // decorateCodeBlocks replaces the pre with the card, so the card is what the
    // direction pass has to leave alone.
    expect(card).not.toBeNull();
    expect(dirsOfTopLevel(block)).toEqual([null]);
  });

  test('never overwrites an explicit dir, and is idempotent', () => {
    const block = decorateBlock('<p dir="ltr">Latin</p><p>שלום</p>');

    expect(dirsOfTopLevel(block)).toEqual(['ltr', 'auto']);

    decorateMarkdown(block, ctx);
    expect(dirsOfTopLevel(block)).toEqual(['ltr', 'auto']);
  });
});
