/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { mapAsync } from '../common';
import {
    IWorkspaceDebugInformationProvider,
    ProjectDebugInformation,
} from '../shared/IWorkspaceDebugInformationProvider';
import { isBlazorWebAssemblyHosted, isBlazorWebAssemblyProject, isWebProject } from '../shared/utils';
import { RoslynLanguageServer } from './roslynLanguageServer';
import {
    ProjectDebugConfiguration,
    WorkspaceDebugConfigurationParams,
    WorkspaceDebugConfigurationRequest,
} from './roslynProtocol';
import { UriConverter } from './uriConverter';

export class RoslynWorkspaceDebugInformationProvider implements IWorkspaceDebugInformationProvider {
    constructor(private server: RoslynLanguageServer, private outputChannel: vscode.OutputChannel) {}

    public async getWorkspaceDebugInformation(
        workspaceFolder: vscode.Uri
    ): Promise<ProjectDebugInformation[] | undefined> {
        if (!this.server.isRunning()) {
            return;
        }

        const params: WorkspaceDebugConfigurationParams = {
            workspacePath: UriConverter.serialize(workspaceFolder),
        };

        let response: ProjectDebugConfiguration[];
        try {
            response = await this.server.sendRequest(
                WorkspaceDebugConfigurationRequest.type,
                params,
                new vscode.CancellationTokenSource().token
            );
        } catch (e) {
            // Server errors are already logged by the language client, but its totally possible
            // that we fail because the server is restarting or a process got killed, etc.
            // Catch the error and log to the correct output (instead of going to the extension host output).
            this.outputChannel.appendLine(`Failed to get debug configuration: ${e}`);
            return;
        }

        // LSP serializes and deserializes URIs as (URI formatted) strings not actual types.  So convert to the actual type here.
        const projects: ProjectDebugInformation[] | undefined = await mapAsync(response, async (p) => {
            const [webProject, webAssemblyProject] = isWebProject(p.projectPath);
            const webAssemblyBlazor = await isBlazorWebAssemblyProject(p.projectPath);
            return {
                projectPath: p.projectPath,
                outputPath: p.outputPath,
                projectName: p.projectName,
                targetsDotnetCore: p.targetsDotnetCore,
                isExe: p.isExe,
                isWebProject: webProject,
                isWebAssemblyProject: webAssemblyProject,
                isBlazorWebAssemblyHosted: isBlazorWebAssemblyHosted(
                    p.isExe,
                    webProject,
                    webAssemblyBlazor,
                    p.targetsDotnetCore
                ),
                isBlazorWebAssemblyStandalone: webAssemblyBlazor,
                solutionPath: p.solutionPath,
            };
        });

        return projects;
    }
}
