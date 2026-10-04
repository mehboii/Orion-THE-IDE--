// Declarative VSIX contributions can be used without executing extension code.
class EditorExtensions {
  constructor(editor) {
    this.editor = editor;
    this.providers = [];
    this.revision = 0;
    this.unsubscribe = window.electronAPI.onExtensionsChanged?.(() => this.reload());
    this.reload();
  }

  async reload() {
    const revision = ++this.revision;
    try {
      const contributions = await window.electronAPI.getExtensionContributions();
      if (revision !== this.revision) return;
      this.providers.forEach(provider => provider.dispose());
      this.providers = [];
      for (const file of contributions.snippets) this.registerSnippets(file);
      const theme = contributions.themes.find(item => item.id === contributions.selectedTheme);
      if (theme) {
        const definition = this.themeDefinition(theme);
        monaco.editor.defineTheme('orion-extension-theme', definition);
        monaco.editor.setTheme('orion-extension-theme');
      } else monaco.editor.setTheme('vs-dark');
      for (const error of contributions.errors) console.warn(`Extension ${error.id}: ${error.message}`);
    } catch (error) { console.warn(`Could not load installed editor contributions: ${error.message}`); }
  }

  registerSnippets(file) {
    const languages = new Map();
    for (const [name, snippet] of Object.entries(file.data)) {
      if (!snippet || typeof snippet !== 'object') continue;
      const prefixes = Array.isArray(snippet.prefix) ? snippet.prefix : [snippet.prefix];
      const body = Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body;
      if (typeof body !== 'string') continue;
      const scopes = file.language ? [file.language] : typeof snippet.scope === 'string' ? snippet.scope.split(',').map(scope => scope.trim()).filter(Boolean) : ['*'];
      for (const language of scopes) {
        if (!languages.has(language)) languages.set(language, []);
        for (const prefix of prefixes) {
          if (typeof prefix !== 'string') continue;
          languages.get(language).push({
            label: prefix, kind: monaco.languages.CompletionItemKind.Snippet,
            detail: `${name} · ${file.extensionId}`, documentation: Array.isArray(snippet.description) ? snippet.description.join('\n') : snippet.description,
            insertText: body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
          });
        }
      }
    }
    for (const [language, snippets] of languages) {
      this.providers.push(monaco.languages.registerCompletionItemProvider(language, {
        provideCompletionItems: (model, position) => {
          const word = model.getWordUntilPosition(position);
          const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
          return { suggestions: snippets.map(snippet => ({ ...snippet, range })) };
        }
      }));
    }
  }

  themeDefinition(theme) {
    const rules = [];
    // Monaco uses token names rather than full TextMate scope selectors.
    // Editor colors transfer directly; token colors are mapped where possible.
    for (const rule of Array.isArray(theme.data.tokenColors) ? theme.data.tokenColors : []) {
      if (!rule.settings || typeof rule.settings !== 'object') continue;
      const scopes = Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === 'string' ? rule.scope.split(',') : [''];
      for (const scope of scopes) {
        if (typeof scope !== 'string' || /[ >]/.test(scope.trim())) continue;
        const token = scope.trim().split('.')[0];
        const converted = { token };
        if (typeof rule.settings.foreground === 'string' && /^#[0-9a-f]{6}$/i.test(rule.settings.foreground)) converted.foreground = rule.settings.foreground.slice(1);
        if (typeof rule.settings.fontStyle === 'string') converted.fontStyle = rule.settings.fontStyle;
        rules.push(converted);
      }
    }
    const colors = Object.fromEntries(Object.entries(theme.data.colors || {}).filter(([, value]) => typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)));
    return { base: ({ vs: 'vs', 'vs-dark': 'vs-dark', 'hc-black': 'hc-black', 'hc-light': 'hc-light' })[theme.uiTheme] || 'vs-dark', inherit: true, rules, colors };
  }
}
