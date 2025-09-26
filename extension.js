const { OpenAI } = require('openai');
const vscode = require('vscode');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

if (process.env.NVIDIA_API && !process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = process.env.NVIDIA_API;
}
console.log('ENV NVIDIA_API =', process.env.NVIDIA_API);
console.log('ENV OPENAI_API_KEY =', process.env.OPENAI_API_KEY);

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
});

let diagnosticCollection;
const pendingTimers = new Map();
const enhancedDiagnosticsStore = new Map();

function activate(context) {
    diagnosticCollection = vscode.languages.createDiagnosticCollection('SafePrompt');
    context.subscriptions.push(diagnosticCollection);

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const doc = event.document;
            scheduleDetectAndEnhancePrompts(doc);
        })
    );
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => scheduleDetectAndEnhancePrompts(doc)));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => scheduleDetectAndEnhancePrompts(doc)));

    context.subscriptions.push(
        vscode.commands.registerCommand('SafePrompt.runScan', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) runSecurityScanAndEnhanced(editor.document);
            else vscode.window.showInformationMessage('Open a supported file to scan.');
        })
    );

    // Quick-fix providers
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            ['javascript', 'javascriptreact', 'python'],
            new HardcodedSecretCodeActionProvider(),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        )
    );
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            ['javascript', 'javascriptreact', 'python'],
            new EnhancedPromptCodeActionProvider(),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        )
    );

    const active = vscode.window.activeTextEditor;
    if (active) runSecurityScanAndEnhanced(active.document);

    console.log('SafePrompt activated');
}

function deactivate() {
    if (diagnosticCollection) diagnosticCollection.clear();
}

function isTargetDoc(document) {
    if (!document) return false;
    return ['javascript', 'javascriptreact', 'python'].includes(document.languageId);
}

function scheduleDetectAndEnhancePrompts(document, delayMs = 800) {
    if (!document) return;
    const key = document.uri.toString();
    if (!pendingTimers.has(key)) pendingTimers.set(key, new Map());

    const timersMap = pendingTimers.get(key);
    if (timersMap.get('__docTimer')) clearTimeout(timersMap.get('__docTimer'));

    const t = setTimeout(() => {
        timersMap.delete('__docTimer');
        runSecurityScanAndEnhanced(document).catch(err => console.error('runSecurityScanAndEnhanced error', err));
    }, delayMs);

    timersMap.set('__docTimer', t);
}

async function runSecurityScanAndEnhanced(document) {
    if (!document) return;
    const securityDiags = findIssuesWithRegex(document);

    await detectAndEnhancePrompts(document);

    const enhancedDiags = enhancedDiagnosticsStore.get(document.uri.toString()) || [];
    const merged = enhancedDiags.concat(securityDiags);

    diagnosticCollection.set(document.uri, merged);
}

async function detectAndEnhancePrompts(document) {
    if (!document || !isTargetDoc(document)) return;
    const text = document.getText();
    const lines = text.split(/\r?\n/);

    const newEnhancedDiags = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Support both JS (// PROMPT:) and Python (# PROMPT:)
        const m = line.match(/^\s*(?:\/\/|#)\s*PROMPT\s*:\s*(.+)$/i);
        if (!m) continue;
        const userPrompt = m[1].trim();
        const loadingRange = new vscode.Range(i, 0, i, Math.max(1, line.length));
        const loadingDiag = new vscode.Diagnostic(
            loadingRange,
            `[NVIDIA] Loading enhanced prompt...`,
            vscode.DiagnosticSeverity.Information
        );
        loadingDiag.code = 'SafePrompt.enhanced_prompt_loading';
        newEnhancedDiags.push(loadingDiag);
        triggerEnhancementRequest(document, i, userPrompt);
    }
    enhancedDiagnosticsStore.set(document.uri.toString(), newEnhancedDiags);
    const securityDiags = findIssuesWithRegex(document);
    diagnosticCollection.set(document.uri, newEnhancedDiags.concat(securityDiags));
}

function triggerEnhancementRequest(document, lineNumber, userPrompt) {
    const docKey = document.uri.toString();
    if (!pendingTimers.has(docKey)) pendingTimers.set(docKey, new Map());
    const timersMap = pendingTimers.get(docKey);
    const inFlightKey = `inflight_${lineNumber}`;
    if (timersMap.get(inFlightKey)) return;

    timersMap.set(inFlightKey, true);
    (async () => {
        try {
            const enhanced = await getEnhancedPromptFromNvidia(userPrompt);
            const range = new vscode.Range(lineNumber, 0, lineNumber, Math.max(1, document.lineAt(lineNumber).text.length));
            const diag = new vscode.Diagnostic(
                range,
                `[NVIDIA] ${enhanced}`,
                vscode.DiagnosticSeverity.Warning
            );
            diag.code = 'SafePrompt.enhanced_prompt';

            const stored = enhancedDiagnosticsStore.get(docKey) || [];
            const filtered = stored.filter(d => d.range.start.line !== lineNumber);
            filtered.push(diag);
            enhancedDiagnosticsStore.set(docKey, filtered);

            const securityDiags = findIssuesWithRegex(document);
            diagnosticCollection.set(document.uri, filtered.concat(securityDiags));
        } catch (err) {
            console.error('Enhancement API failed:', err);
            const range = new vscode.Range(lineNumber, 0, lineNumber, Math.max(1, document.lineAt(lineNumber).text.length));
            const diag = new vscode.Diagnostic(
                range,
                `[NVIDIA] Failed to generate enhancement: ${String(err.message || err)}`,
                vscode.DiagnosticSeverity.Warning
            );
            diag.code = 'SafePrompt.enhanced_prompt_failed';
            const stored = enhancedDiagnosticsStore.get(docKey) || [];
            const filtered = stored.filter(d => d.range.start.line !== lineNumber);
            filtered.push(diag);
            enhancedDiagnosticsStore.set(docKey, filtered);
            const securityDiags = findIssuesWithRegex(document);
            diagnosticCollection.set(document.uri, filtered.concat(securityDiags));
        } finally {
            timersMap.delete(inFlightKey);
        }
    })();
}

async function getEnhancedPromptFromNvidia(userPrompt) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set (map NVIDIA_API -> OPENAI_API_KEY or set it directly).');
    }
    const systemPrompt = `You are a secure coding assistant. Enhance a developer's code-generation prompt by adding security best practices (authentication, input validation, avoiding hardcoded secrets, RBAC, CSRF protections, secure defaults). Produce a short enhanced prompt.`;
    const userMessage = `Enhance this code-generation prompt with security best practices: "${userPrompt}"`;

    const completion = await openai.chat.completions.create({
        model: "nvidia/llama-3.1-nemotron-70b-instruct",
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ],
        temperature: 0.2,
        top_p: 1,
        max_tokens: 180
    });
    const enhanced = completion?.choices?.[0]?.message?.content;
    if (!enhanced || !enhanced.trim()) throw new Error('Empty response from NVIDIA model');
    return enhanced.trim();
}

function findIssuesWithRegex(document) {
    const diagnostics = [];
    if (!document) return diagnostics;
    const lines = document.getText().split(/\r?\n/);

    const secretRegex = /(api[_-]?key|apikey|secret|token)\s*[:=]\s*['"`]([^'"`]+)['"`]/i;
    lines.forEach((line, i) => {
        const m = line.match(secretRegex);
        if (m) {
            const startCol = line.indexOf(m[0]) >= 0 ? line.indexOf(m[0]) : 0;
            const range = new vscode.Range(i, startCol, i, line.length);
            const diag = new vscode.Diagnostic(
                range,
                'Hardcoded secret detected. Consider using environment variables.',
                vscode.DiagnosticSeverity.Warning
            );
            diag.code = 'SafePrompt.hardcoded_secret';
            diagnostics.push(diag);
        }
    });

    // Support JS and Python function definitions
    const funcRegex = /(function\s+([a-zA-Z0-9_]+)\s*\(|const\s+([a-zA-Z0-9_]+)\s*=\s*\(.*\)\s*=>|def\s+([a-zA-Z0-9_]+)\s*\()/i;
    lines.forEach((line, i) => {
        const m = line.match(funcRegex);
        if (m) {
            const name = m[2] || m[3] || m[4] || '';
            if (/login|auth|getuser|admin/i.test(name)) {
                let hasAuth = false;
                for (let j = i; j < Math.min(lines.length, i + 8); j++) {
                    if (/role|authorize|auth|req.user|hasRole/i.test(lines[j])) { hasAuth = true; break; }
                }
                if (!hasAuth) {
                    const range = new vscode.Range(i, 0, i, line.length);
                    const diag = new vscode.Diagnostic(range,
                        `Possible missing authorization check in function "${name}".`,
                        vscode.DiagnosticSeverity.Warning);
                    diag.code = 'SafePrompt.missing_auth';
                    diagnostics.push(diag);
                }
            }
        }
    });

    return diagnostics;
}

class HardcodedSecretCodeActionProvider {
    provideCodeActions(document, range, context) {
        const actions = [];
        for (const diag of context.diagnostics) {
            if (diag.code === 'SafePrompt.hardcoded_secret') {
                const title = 'Replace literal with process.env reference';
                const fix = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                fix.diagnostics = [diag];

                const line = document.lineAt(range.start.line).text;
                let envName = 'SECRET';
                const secretMatch = line.match(/(api[_-]?key|apikey|secret|token)/i);
                if (secretMatch) envName = secretMatch[1].toUpperCase().replace(/[^A-Z0-9_]/g, '_');

                const edit = new vscode.WorkspaceEdit();
                const quoteMatch = line.match(/(['"`])([^'"`]+)\1/);
                if (quoteMatch) {
                    const quoteStart = line.indexOf(quoteMatch[0]);
                    const quoteEnd = quoteStart + quoteMatch[0].length;
                    edit.replace(document.uri, new vscode.Range(range.start.line, quoteStart, range.start.line, quoteEnd), `process.env.${envName}`);
                } else {
                    edit.replace(document.uri, new vscode.Range(range.start.line, 0, range.start.line, line.length), line.replace(/=['"`].*['"`]/, `= process.env.${envName}`));
                }
                fix.edit = edit;
                fix.command = { command: 'SafePrompt.runScan', title: 'Rescan (SafePrompt)' };
                actions.push(fix);
            }
        }
        return actions;
    }
}

class EnhancedPromptCodeActionProvider {
    provideCodeActions(document, range, context) {
        const actions = [];
        for (const diag of context.diagnostics) {
            if (diag.code === 'SafePrompt.enhanced_prompt') {
                const fix = new vscode.CodeAction('Insert enhanced prompt below', vscode.CodeActionKind.QuickFix);
                fix.edit = new vscode.WorkspaceEdit();
                const message = diag.message.replace(/^\[NVIDIA\]\s*/, '').replace(/^\[Enhanced\]\s*/, '');
                fix.edit.insert(document.uri, new vscode.Position(range.end.line + 1, 0), `# ENHANCED_PROMPT: ${message}\n`);
                actions.push(fix);
            }
        }
        return actions;
    }
}

module.exports = { activate, deactivate };
