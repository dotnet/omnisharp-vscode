/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * This tracks a debug session until C# dev kit is loaded (if present) and STOPS tracking any existing
 * debug session after C# dev kit is loaded.
 * The idea is to avoid a race condition if a debugging session starts before C# dev kit is initialized,
 * since the brokered service pipe name will be sent with a 'launch' command.
 * If the extension loads during an existing session, rather than not initializing any C# dev kit services (such as hot reload),
 * this sends a custom request to the engine with the brokered service pipe name in order to initialize it.
 */
export class ProvisionalDebugSessionTracker {
    private _sessions: Set<vscode.DebugSession> | undefined = new Set<vscode.DebugSession>();

    private _onDidStartDebugSession: vscode.Disposable | undefined;
    private _onDidTerminateDebugSession: vscode.Disposable | undefined;

    private _brokeredServicePipeName: string | undefined;

    /**
     * Initializes the debug session handlers.
     */
    initializeDebugSessionHandlers(context: vscode.ExtensionContext): void {
        this._onDidStartDebugSession = vscode.debug.onDidStartDebugSession(this.onDidStartDebugSession.bind(this));

        this._onDidTerminateDebugSession = vscode.debug.onDidTerminateDebugSession((session: vscode.DebugSession) => {
            this.onDidTerminateDebugSession(session);
        });

        context.subscriptions.push(this._onDidStartDebugSession);
        context.subscriptions.push(this._onDidTerminateDebugSession);
    }

    /**
     * Tracks a debug session until it is terminated.
     * @param session Debug session.
     */
    onDidStartDebugSession(session: vscode.DebugSession): void {
        if (session.type !== 'coreclr' && session.type !== 'monovsdbg') {
            return;
        }

        this._sessions?.add(session);
    }

    /**
     * Notifies that a debug session has been terminated.
     */
    onDidTerminateDebugSession(session: vscode.DebugSession): void {
        this._sessions?.delete(session);
    }

    /**
     * If there is any active debug session, this notifies the engine that csdevkit was loaded.
     * @param csDevKitPipeName Brokered service pipe name activated by {@link CSharpDevKitExports}.
     */
    async onCsDevKitInitialized(csDevKitPipeName: string): Promise<void> {
        this._brokeredServicePipeName = csDevKitPipeName;

        const sessions = this._sessions;
        if (sessions != undefined) {
            // Debugging session already started, send a custom DAP request to the engine.
            sessions.forEach((s) => s.customRequest('initializeBrokeredServicePipeName', csDevKitPipeName));
        }

        // Since C# dev kit was initialized, we no longer need to track debugging sessions.
        this.cleanup();
    }

    /**
     * Fetches the brokered service pipe name from C# dev kit, if available.
     */
    getBrokeredServicePipeName(): string | undefined {
        return this._brokeredServicePipeName;
    }

    /**
     * No longer tracks any debugging session going forward.
     */
    cleanup(): void {
        this._sessions?.clear();
        this._sessions = undefined;

        this._onDidStartDebugSession?.dispose();
        this._onDidTerminateDebugSession?.dispose();
    }
    getDebugSessionByType(type: string): vscode.DebugSession | undefined {
        const sessions = this._sessions;
        if (sessions != undefined) {
            const sessionsIt = sessions.entries();
            for (const session of sessionsIt) {
                if (session[0].type == type) {
                    return session[0];
                }
            }
        }
        return undefined;
    }
}

export const debugSessionTracker = new ProvisionalDebugSessionTracker();
