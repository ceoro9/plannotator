// Mock VS Code module for bun:test
// Only implements the APIs that plannotator-webview actually uses.

export interface UriHandler {
  handleUri(uri: Uri): ProviderResult<void>;
}

type Thenable<T> = PromiseLike<T>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProviderResult<T> =
  | T
  | undefined
  | null
  | Thenable<T | undefined | null>;

export interface Disposable {
  dispose(): void;
}
export interface LogOutputChannel extends Disposable {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
  appendLine(message: string): void;
}
export interface TextEditorDecorationType extends Disposable {}
export interface TextDocument {
  uri: Uri;
  getText(range?: Range): string;
}
export interface TextEditor {
  document: TextDocument;
  selection: Range;
  setDecorations(type: TextEditorDecorationType, ranges: Range[]): void;
}
export interface Comment {
  body: string;
  mode: number;
  author: { name: string };
}
export interface CommentThread {
  uri: Uri;
  range?: Range;
  comments: Comment[];
  collapsibleState: number;
  canReply: boolean;
  contextValue: string;
  dispose(): void;
}
export interface CommentReply {
  thread: CommentThread;
  text: string;
}
export interface CommentController extends Disposable {
  options: { prompt?: string; placeHolder?: string };
  createCommentThread(
    uri: Uri,
    range: Range,
    comments: Comment[],
  ): CommentThread;
}

export interface ExtensionContext {
  subscriptions: { dispose(): void }[];
  extensionPath: string;
  workspaceState: {
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
  };
  environmentVariableCollection: {
    replace(variable: string, value: string): void;
    append(variable: string, value: string): void;
    prepend(variable: string, value: string): void;
    delete(variable: string): void;
  };
  globalState: {
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
  };
}

export class Uri {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;

  get fsPath(): string {
    return this.path;
  }

  constructor(
    scheme: string,
    authority: string,
    path: string,
    query: string,
    fragment: string,
  ) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  static file(fsPath: string): Uri {
    return new Uri("file", "", fsPath, "", "");
  }

  static parse(value: string): Uri {
    const parsed = new globalThis.URL(value);
    return new Uri(
      parsed.protocol.replace(":", ""),
      parsed.host,
      parsed.pathname,
      parsed.search.replace("?", ""),
      parsed.hash.replace("#", ""),
    );
  }

  toString(): string {
    let result = `${this.scheme}://${this.authority}${this.path}`;
    if (this.query) result += `?${this.query}`;
    if (this.fragment) result += `#${this.fragment}`;
    return result;
  }
}

export const commands = {
  registerCommand<T extends (...args: never[]) => unknown>(
    _id: string,
    _handler: T,
  ) {
    return { dispose() {} };
  },
  async executeCommand(_command: string, ..._args: unknown[]) {},
};

export interface Webview {
  html: string;
  onDidReceiveMessage(listener: (message: unknown) => void): {
    dispose(): void;
  };
  postMessage(message: unknown): Thenable<boolean>;
}

export interface WebviewPanel {
  webview: Webview;
  iconPath?: Uri;
  active: boolean;
  reveal(viewColumn?: number): void;
  dispose(): void;
  onDidDispose(listener: () => void): { dispose(): void };
  onDidChangeViewState(
    listener: (event: { webviewPanel: WebviewPanel }) => void,
  ): { dispose(): void };
}

export const ViewColumn = {
  One: 1,
  Two: 2,
  Three: 3,
};

export const StatusBarAlignment = { Left: 1, Right: 2 };

export const window = {
  registerUriHandler(_handler: unknown) {
    return { dispose() {} };
  },
  async showInformationMessage(_message: string) {
    return undefined;
  },
  async showErrorMessage(_message: string) {
    return undefined;
  },
  async showWarningMessage(
    _message: string,
    _options?: unknown,
    ..._items: string[]
  ) {
    return undefined;
  },
  async showInputBox(_options?: unknown) {
    return undefined;
  },
  createOutputChannel(_name: string, _options?: unknown): LogOutputChannel {
    return {
      info() {},
      warn() {},
      error() {},
      debug() {},
      appendLine() {},
      dispose() {},
    };
  },
  createStatusBarItem(_alignment?: number, _priority?: number) {
    return {
      text: "",
      tooltip: undefined as string | undefined,
      command: undefined as string | undefined,
      show() {},
      hide() {},
      dispose() {},
    };
  },
  createWebviewPanel(
    _viewType: string,
    _title: string,
    _showOptions: number,
    _options?: { enableScripts?: boolean; retainContextWhenHidden?: boolean },
  ): WebviewPanel {
    let disposeListener: (() => void) | null = null;
    const panel: WebviewPanel = {
      webview: {
        html: "",
        onDidReceiveMessage() {
          return { dispose() {} };
        },
        postMessage() {
          return Promise.resolve(true);
        },
      },
      active: true,
      reveal() {},
      dispose() {
        disposeListener?.();
      },
      onDidDispose(listener: () => void) {
        disposeListener = listener;
        return { dispose() {} };
      },
      onDidChangeViewState() {
        return { dispose() {} };
      },
    };
    return panel;
  },
  createTextEditorDecorationType(_options: unknown): TextEditorDecorationType {
    return { dispose() {} };
  },
  get activeTextEditor(): TextEditor | undefined {
    return undefined;
  },
  get visibleTextEditors(): TextEditor[] {
    return [];
  },
  onDidChangeActiveTextEditor(
    _listener: (editor: TextEditor | undefined) => void,
  ) {
    return { dispose() {} };
  },
};

export const env = {
  async asExternalUri(uri: Uri): Promise<Uri> {
    return uri;
  },
  clipboard: {
    async readText(): Promise<string> {
      return "";
    },
    async writeText(_value: string): Promise<void> {},
  },
};

export const comments = {
  createCommentController(_id: string, _label: string): CommentController {
    return {
      options: {},
      dispose() {},
      createCommentThread(_uri: Uri, _range: Range, _comments: Comment[]) {
        return {
          uri: _uri,
          range: _range,
          comments: _comments,
          collapsibleState: 0,
          canReply: true,
          contextValue: "",
          dispose() {},
        };
      },
    };
  },
};

export const languages = {
  registerCodeActionsProvider(
    _selector: unknown,
    _provider: unknown,
    _metadata?: unknown,
  ) {
    return { dispose() {} };
  },
};

export class Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
  isEmpty: boolean;
  constructor(
    startLine: number | { line: number; character: number },
    startChar?: number | { line: number; character: number },
    endLine?: number,
    endChar?: number,
  ) {
    if (typeof startLine === "object") {
      this.start = startLine;
      this.end = startChar as { line: number; character: number };
    } else {
      this.start = { line: startLine, character: startChar as number };
      this.end = { line: endLine!, character: endChar! };
    }
    this.isEmpty =
      this.start.line === this.end.line &&
      this.start.character === this.end.character;
  }
  isEqual(other: Range) {
    return (
      this.start.line === other.start.line &&
      this.start.character === other.start.character &&
      this.end.line === other.end.line &&
      this.end.character === other.end.character
    );
  }
}

export const CommentMode = { Preview: 1, Editing: 0 };
export const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 };

export class CodeAction {
  command?: { command: string; title: string };
  constructor(
    public title: string,
    public kind: unknown,
  ) {}
}

export const CodeActionKind = {
  RefactorInline: { value: "refactor.inline" },
};

export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 };

export const workspace = {
  workspaceFolders: undefined as { uri: Uri }[] | undefined,
  async openTextDocument(uri: Uri): Promise<TextDocument> {
    return { uri, getText: () => "" };
  },
  asRelativePath(uri: Uri, _includeWorkspaceFolder?: boolean): string {
    return uri.path;
  },
  getConfiguration(_section?: string) {
    return {
      get(_key: string, defaultValue?: unknown) {
        return defaultValue;
      },
    };
  },
};

// Mock EnvironmentVariableCollection
class MockEnvironmentVariableCollection {
  private _vars = new Map<string, string>();

  replace(variable: string, value: string) {
    this._vars.set(variable, value);
  }

  append(variable: string, value: string) {
    this._vars.set(variable, (this._vars.get(variable) || "") + value);
  }

  prepend(variable: string, value: string) {
    this._vars.set(variable, value + (this._vars.get(variable) || ""));
  }

  delete(variable: string) {
    this._vars.delete(variable);
  }

  get(variable: string) {
    return this._vars.get(variable);
  }

  clear() {
    this._vars.clear();
  }

  [Symbol.iterator]() {
    return this._vars.entries();
  }
}

// Factory to create a mock ExtensionContext
export function createMockExtensionContext(
  extensionPath = "/mock/extension/path",
) {
  return {
    subscriptions: [] as { dispose: () => void }[],
    extensionPath,
    environmentVariableCollection: new MockEnvironmentVariableCollection(),
    globalState: (() => {
      const store = new Map<string, unknown>();
      return {
        get<T>(key: string, defaultValue?: T): T | undefined {
          return (store.has(key) ? store.get(key) : defaultValue) as
            | T
            | undefined;
        },
        update(key: string, value: unknown): Promise<void> {
          store.set(key, value);
          return Promise.resolve();
        },
      };
    })(),
    workspaceState: { get: () => undefined, update: async () => {} },
  };
}
