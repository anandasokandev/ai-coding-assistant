import * as vscode from 'vscode';
import axios, { AxiosError, CancelTokenSource } from 'axios';

const diag = vscode.languages.createDiagnosticCollection("ai");

let statusBarItem: vscode.StatusBarItem;
let isAnalysisEnabled = true;

// Smart analysis control
let analyzeTimer: NodeJS.Timeout | null = null;
let cancelSource: CancelTokenSource | null = null;
let isAnalyzing = false;

export function activate(context: vscode.ExtensionContext) {
    console.log("AI Coding Agent Activated");

    const config = vscode.workspace.getConfiguration('aiAgent');

    // ----------------- STATUS BAR -----------------
    if (config.get<boolean>('showStatusBar', true)) {
        statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        statusBarItem.command = "ai.toggleAnalysis";
        statusBarItem.show();
        context.subscriptions.push(statusBarItem);
    }

    isAnalysisEnabled = config.get<boolean>('autoAnalyze', true);
    updateStatusBar();

    // ----------------- WATCH CODE CHANGES -----------------
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (!isAnalysisEnabled) return;
            if (event.document.uri.scheme !== "file") return;

            const config = vscode.workspace.getConfiguration('aiAgent');
            const enabled = config.get<string[]>('enabledLanguages', []);
            if (enabled.length && !enabled.includes(event.document.languageId)) return;

            const maxFile = config.get<number>('maxFileSize', 100000);
            if (event.document.getText().length > maxFile) return;

            scheduleAnalysis(event.document);
        })
    );

    // ----------------- PROVIDE QUICK FIX -----------------
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider("*", {
            provideCodeActions(document, range, context) {
                const actions: vscode.CodeAction[] = [];

                for (const d of context.diagnostics) {
                    if (d.source !== "AI Agent") continue;

                    const fixAction = new vscode.CodeAction(
                        "🤖 AI: Fix Issue",
                        vscode.CodeActionKind.QuickFix
                    );

                    fixAction.command = {
                        command: "ai.fix",
                        title: "AI Fix",
                        arguments: [document, d.range]
                    };

                    fixAction.diagnostics = [d];
                    fixAction.isPreferred = true;

                    actions.push(fixAction);
                }

                return actions;
            }
        })
    );

    // ----------------- COMMANDS -----------------

    // Manual analyze
    context.subscriptions.push(
        vscode.commands.registerCommand("ai.analyze", async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) await analyzeDocument(editor.document);
        })
    );

    // FIX (Fully Corrected)
    context.subscriptions.push(
        vscode.commands.registerCommand("ai.fix", async (docArg: any, rangeArg: any) => {

            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            let document: vscode.TextDocument;
            let range: vscode.Range;

            // Normalize document
            if (docArg && typeof docArg.getText === "function") {
                document = docArg;
            } else {
                document = editor.document;
            }

            // Normalize range
            if (rangeArg instanceof vscode.Range) {
                range = rangeArg;
            } else {
                range = editor.selection;
            }

            await fixCode(document, range);
        })
    );

    // Explain
    context.subscriptions.push(
        vscode.commands.registerCommand("ai.explain", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const selection = editor.selection;
            const code = editor.document.getText(selection);

            if (!code.trim()) {
                vscode.window.showWarningMessage("Please select code to explain");
                return;
            }

            await explainCode(code, editor.document.languageId);
        })
    );

    // Toggle analysis
    context.subscriptions.push(
        vscode.commands.registerCommand("ai.toggleAnalysis", () => {
            isAnalysisEnabled = !isAnalysisEnabled;
            updateStatusBar();
            vscode.window.showInformationMessage(
                isAnalysisEnabled ? "AI auto-analysis enabled" : "AI auto-analysis disabled"
            );
        })
    );

    // Config updates
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("aiAgent")) {
                const cfg = vscode.workspace.getConfiguration("aiAgent");
                isAnalysisEnabled = cfg.get<boolean>('autoAnalyze', true);
                updateStatusBar();
            }
        })
    );
}

// ╔════════════════════════════════════════════╗
// ║            SMART ANALYSIS SYSTEM           ║
// ╚════════════════════════════════════════════╝

function scheduleAnalysis(doc: vscode.TextDocument) {
    const config = vscode.workspace.getConfiguration('aiAgent');
    const debounceMs = config.get<number>('debounceMs', 1500);

    if (analyzeTimer) clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(() => analyzeDocument(doc), debounceMs);
}

async function analyzeDocument(doc: vscode.TextDocument) {
    const config = vscode.workspace.getConfiguration('aiAgent');
    const SERVER = config.get<string>('serverUrl', 'http://localhost:4000');

    if (isAnalyzing) return;

    const code = doc.getText();
    if (!code.trim()) {
        diag.set(doc.uri, []);
        return;
    }

    try {
        isAnalyzing = true;
        updateStatusBar("analyzing");

        if (cancelSource) cancelSource.cancel("New request started");
        cancelSource = axios.CancelToken.source();

        const response = await axios.post(
            `${SERVER}/analyze`,
            { code, language: doc.languageId },
            { timeout: 30000, cancelToken: cancelSource.token }
        );

        const issues = response.data?.issues || [];
        const diagnostics: vscode.Diagnostic[] = [];

        for (const issue of issues) {
            if (!issue.start || !issue.end || !issue.message) continue;

            const range = new vscode.Range(
                new vscode.Position(issue.start.line, issue.start.character),
                new vscode.Position(issue.end.line, issue.end.character)
            );

            const d = new vscode.Diagnostic(
                range,
                issue.message,
                vscode.DiagnosticSeverity.Warning
            );

            d.source = "AI Agent";
            diagnostics.push(d);
        }

        diag.set(doc.uri, diagnostics);
        updateStatusBar("idle", diagnostics.length);

    } catch (err) {
        if (!axios.isCancel(err)) {
            handleError(err, "Analyze failed");
            updateStatusBar("error");
        }
    } finally {
        isAnalyzing = false;
    }
}

// ╔════════════════════════════════════════════╗
// ║                   FIX CODE                 ║
// ╚════════════════════════════════════════════╝

async function fixCode(doc: vscode.TextDocument, range: vscode.Range) {
    const config = vscode.workspace.getConfiguration('aiAgent');
    const SERVER = config.get<string>('serverUrl', 'http://localhost:4000');

    try {
        updateStatusBar("fixing");

        // 1. Expand selection to full code block
        const blockRange = findCodeBlockRange(doc, range);
        const code = doc.getText(blockRange);

        // 2. Send entire block to AI
        const resp = await axios.post(`${SERVER}/fix`, {
            code,
            language: doc.languageId
        });

        if (!resp.data?.output) throw new Error("Invalid AI response");

        const editor = await vscode.window.showTextDocument(doc);

        // 3. Replace entire block, not a line
        await editor.edit(edit => {
            edit.replace(blockRange, resp.data.output);
        });

        diag.delete(doc.uri);
        updateStatusBar("idle");
        vscode.window.showInformationMessage("AI Fix Applied");

    } catch (err) {
        updateStatusBar("error");
        handleError(err, "Fix failed");
    }
}

function findCodeBlockRange(doc: vscode.TextDocument, range: vscode.Range): vscode.Range {
    let start = range.start.line;
    let end = range.end.line;

    // Move upward until we find '{'
    while (start > 0) {
        const line = doc.lineAt(start).text;
        if (line.includes("{")) break;
        start--;
    }

    // Move downward until we find '}'
    while (end < doc.lineCount - 1) {
        const line = doc.lineAt(end).text;
        if (line.includes("}")) break;
        end++;
    }

    const startPos = new vscode.Position(start, 0);
    const endPos = new vscode.Position(end, doc.lineAt(end).text.length);

    return new vscode.Range(startPos, endPos);
}


// ╔════════════════════════════════════════════╗
// ║                EXPLAIN CODE                ║
// ╚════════════════════════════════════════════╝

async function explainCode(code: string, language: string) {
    const config = vscode.workspace.getConfiguration('aiAgent');
    const SERVER = config.get<string>('serverUrl', 'http://localhost:4000');

    try {
        const resp = await axios.post(
            `${SERVER}/explain`,
            { code, language },
            { timeout: 30000 }
        );

        const explanation = resp.data?.output || "No explanation available";

        const panel = vscode.window.createWebviewPanel(
            "aiExplain",
            "AI Explanation",
            vscode.ViewColumn.Beside,
            { enableScripts: false }
        );

        const cleanedExplanation = stripMarkdown(explanation);


        panel.webview.html = getStyledHTML(code, cleanedExplanation);
    } catch (err) {
        handleError(err, "Explain failed");
    }
}

function stripMarkdown(text: string): string {
    if (!text) return "";
    return text
        .replace(/\*\*(.*?)\*\*/g, '$1')     // bold
        .replace(/`(.*?)`/g, '$1')           // inline code
        .replace(/_(.*?)_/g, '$1')           // italic
        .replace(/#+\s?(.*)/g, '$1')         // headings
        .replace(/>\s?(.*)/g, '$1')          // blockquote
        .replace(/[*-] /g, '')               // list bullets
        .trim();
}


function getStyledHTML(code: string, explanation: string) {
    return `
    <html>
    <head>
        <style>
            body {
                font-family: Consolas, monospace;
                background: #1e1e1e;
                color: #d4d4d4;
                padding: 20px;
            }

            h2 {
                margin-top: 20px;
                color: #4fc1ff;
                font-weight: 600;
                border-bottom: 1px solid #333;
                padding-bottom: 6px;
            }

            pre {
                background: #000000ff;
                padding: 15px;
                border-radius: 6px;
                overflow-x: auto;
                white-space: pre-wrap;
                word-wrap: break-word;
                font-size: 14px;
                border: 1px solid #333;
            }

            code {
                color: #c5c8c6;
            }

            .container {
                max-width: 900px;
                margin: auto;
            }
        </style>
    </head>

    <body>
        <div class="container">
            <h2>Selected Code</h2>
            <pre><code>${escapeHTML(code)}</code></pre>

            <h2>Explanation</h2>
            <pre><code>${escapeHTML(explanation)}</code></pre>
        </div>
    </body>
    </html>
    `;
}
// ╔════════════════════════════════════════════╗
// ║            STATUS BAR + UTILS              ║
// ╚════════════════════════════════════════════╝

function updateStatusBar(
    state: "idle" | "analyzing" | "fixing" | "error" = "idle",
    issueCount = 0
) {
    if (!statusBarItem) return;

    if (!isAnalysisEnabled) {
        statusBarItem.text = "$(eye-closed) AI Off";
        return;
    }

    switch (state) {
        case "analyzing":
            statusBarItem.text = "$(sync~spin) Analyzing…";
            break;
        case "fixing":
            statusBarItem.text = "$(sync~spin) Fixing…";
            break;
        case "error":
            statusBarItem.text = "$(error) AI Error";
            break;
        default:
            statusBarItem.text = issueCount
                ? `$(check) AI (${issueCount})`
                : "$(check) AI Ready";
    }
}

function escapeHTML(str: string) {
    return str.replace(/[&<>"]/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)
    );
}

function handleError(error: any, msg: string) {
    if (axios.isCancel(error)) return;

    if (axios.isAxiosError(error)) {
        vscode.window.showErrorMessage(`${msg}: ${error.message}`);
    } else {
        vscode.window.showErrorMessage(`${msg}: ${String(error)}`);
    }

    console.error(msg, error);
}



export function deactivate() {
    diag.clear();
    diag.dispose();
}
