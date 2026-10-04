const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

(async () => {
  let data = { themes: [], snippets: [], errors: [], selectedTheme: null }, onChange;
  const registered = [], disposed = [], definitions = [], selections = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Snippet: 27 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (language, provider) => {
        const entry = { language, provider }; registered.push(entry);
        return { dispose: () => disposed.push(entry) };
      }
    },
    editor: { defineTheme: (id, definition) => definitions.push({ id, definition }), setTheme: id => selections.push(id) }
  };
  const api = {
    getExtensionContributions: async () => data,
    onExtensionsChanged: callback => { onChange = callback; return () => {}; }
  };
  const context = vm.createContext({ window: { electronAPI: api }, monaco, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/editor-extensions.js'), 'utf8') + '\nglobalThis.EditorExtensions = EditorExtensions;', context);
  const runtime = new context.EditorExtensions({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(selections.at(-1), 'vs-dark', 'installing packages must not change the default theme');
  data = { selectedTheme: 'demo.theme:dark', errors: [], themes: [
    { id: 'demo.theme:dark', uiTheme: 'vs-dark', data: { colors: { 'editor.background': '#112233' }, tokenColors: [{ scope: 'keyword.control', settings: { foreground: '#abcdef', fontStyle: 'bold' } }] } }
  ], snippets: [
    { extensionId: 'demo.snippets', language: 'javascript', data: { Log: { prefix: ['log', 'print'], body: ['console.log(${1:value});', '$0'], description: 'Log a value' } } },
    { extensionId: 'demo.global', data: { Global: { prefix: 'global', body: '$0' }, Scoped: { scope: 'python, javascript', prefix: 'scoped', body: 'scoped($1)' } } }
  ] };
  await onChange();
  const javascript = registered.find(entry => entry.language === 'javascript');
  const completions = javascript.provider.provideCompletionItems({ getWordUntilPosition: () => ({ startColumn: 4, endColumn: 7 }) }, { lineNumber: 2, column: 7 });
  assert.equal(completions.suggestions.length, 2);
  assert.equal(completions.suggestions[0].insertText, 'console.log(${1:value});\n$0');
  assert.equal(completions.suggestions[0].insertTextRules, 4);
  assert.equal(completions.suggestions[0].range.startLineNumber, 2);
  assert.equal(completions.suggestions[0].range.startColumn, 4);
  assert(registered.some(entry => entry.language === '*'));
  assert(registered.some(entry => entry.language === 'python'));
  assert.equal(definitions.at(-1).definition.colors['editor.background'], '#112233');
  assert.equal(definitions.at(-1).definition.rules[0].foreground, 'abcdef');
  assert.equal(selections.at(-1), 'orion-extension-theme');
  const count = registered.length;
  data = { themes: [], snippets: [], errors: [], selectedTheme: 'demo.theme:dark' };
  await onChange();
  assert.equal(disposed.length, count, 'uninstall disposes snippet providers');
  assert.equal(selections.at(-1), 'vs-dark', 'removing the selected theme restores the default');

  let resolveSlow;
  api.getExtensionContributions = () => new Promise(resolve => { resolveSlow = resolve; });
  const slow = runtime.reload();
  api.getExtensionContributions = async () => data;
  await runtime.reload();
  const themeCalls = selections.length;
  resolveSlow({ ...data, selectedTheme: 'demo.theme:dark', themes: [{ id: 'demo.theme:dark', data: {} }] });
  await slow;
  assert.equal(selections.length, themeCalls, 'an old contribution response cannot overwrite newer settings');
  console.log('PASS editor snippet completion, scopes, theme selection, uninstall cleanup, and reload races');
})().catch(error => { console.error(error); process.exitCode = 1; });
