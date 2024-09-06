/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { addAssetsIfNecessary, generateAssets } from '../shared/assets';
import { DotnetWorkspaceConfigurationProvider } from '../shared/workspaceConfigurationProvider';
import { IWorkspaceDebugInformationProvider } from '../shared/IWorkspaceDebugInformationProvider';
import { RoslynLanguageServer } from './roslynLanguageServer';
import { RoslynWorkspaceDebugInformationProvider } from './roslynWorkspaceDebugConfigurationProvider';
import { PlatformInformation } from '../shared/platform';
import { ServerState } from './serverStateChange';
import { DotnetConfigurationResolver } from '../shared/dotnetConfigurationProvider';
import { getCSharpDevKit } from '../utils/getCSharpDevKit';
import { RoslynLanguageServerEvents } from './languageServerEvents';

export function registerDebugger(
    context: vscode.ExtensionContext,
    languageServer: RoslynLanguageServer,
    languageServerEvents: RoslynLanguageServerEvents,
    platformInfo: PlatformInformation,
    csharpOutputChannel: vscode.OutputChannel
) {
    const workspaceInformationProvider: IWorkspaceDebugInformationProvider =
        new RoslynWorkspaceDebugInformationProvider(languageServer, csharpOutputChannel);

    const disposable = languageServerEvents.onServerStateChange(async (e) => {
        if (e.state === ServerState.ProjectInitializationComplete) {
            const csharpDevkitExtension = getCSharpDevKit();
            if (!csharpDevkitExtension) {
                // Update or add tasks.json and launch.json
                await addAssetsIfNecessary(context, workspaceInformationProvider);
            }
        }
    });
    context.subscriptions.push(disposable);

    const dotnetWorkspaceConfigurationProvider = new DotnetWorkspaceConfigurationProvider(
        workspaceInformationProvider,
        platformInfo,
        csharpOutputChannel
    );

    // Register ConfigurationProvider
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(
            'dotnet',
            new DotnetConfigurationResolver(workspaceInformationProvider, dotnetWorkspaceConfigurationProvider)
        )
    );
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('coreclr', dotnetWorkspaceConfigurationProvider)
    );

    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('monovsdbg', dotnetWorkspaceConfigurationProvider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('dotnet.generateAssets', async (selectedIndex) =>
            generateAssets(workspaceInformationProvider, selectedIndex)
        )
    );
}
