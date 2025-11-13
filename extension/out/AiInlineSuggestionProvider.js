"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiInlineSuggestionProvider = void 0;
const vscode = require("vscode");
const axios_1 = require("axios");
class AiInlineSuggestionProvider {
    async provideInlineCompletionItems(document, position, context, token) {
        try {
            const config = vscode.workspace.getConfiguration('aiAgent');
            const SERVER = config.get('serverUrl', 'http://localhost:4000');
            const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
            // Cancel previous request if typing fast
            if (this.lastRequest) {
                this.lastRequest.cancel("New suggestion requested");
            }
            this.lastRequest = axios_1.default.CancelToken.source();
            const resp = await axios_1.default.post(`${SERVER}/suggest`, { code: textBeforeCursor, language: document.languageId }, { timeout: 7500, cancelToken: this.lastRequest.token });
            const suggestion = resp.data?.completion || resp.data?.output;
            if (!suggestion)
                return;
            return {
                items: [
                    new vscode.InlineCompletionItem(suggestion, new vscode.Range(position, position))
                ]
            };
        }
        catch (err) {
            if (!axios_1.default.isCancel(err)) {
                console.error("Inline suggestion error:", err);
            }
            return;
        }
    }
}
exports.AiInlineSuggestionProvider = AiInlineSuggestionProvider;
//# sourceMappingURL=AiInlineSuggestionProvider.js.map