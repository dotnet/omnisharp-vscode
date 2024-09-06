/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as serverUtils from './omnisharp/utils';
import {
    IWorkspaceDebugInformationProvider,
    ProjectDebugInformation,
} from './shared/IWorkspaceDebugInformationProvider';
import { OmniSharpServer } from './omnisharp/server';
import { Uri } from 'vscode';
import { findNetCoreTargetFramework } from './shared/utils';
import { isSubfolderOf } from './common';

export class OmnisharpWorkspaceDebugInformationProvider implements IWorkspaceDebugInformationProvider {
    constructor(private server: OmniSharpServer) {}

    public async getWorkspaceDebugInformation(workspacePath: Uri): Promise<ProjectDebugInformation[] | undefined> {
        if (!this.server.isRunning()) {
            return;
        }

        const workspaceInfo = await serverUtils.requestWorkspaceInformation(this.server);

        const projects: ProjectDebugInformation[] | undefined = workspaceInfo.MsBuild?.Projects.map((p) => {
            const targetsDotnetCore =
                findNetCoreTargetFramework(p.TargetFrameworks.map((tf) => tf.ShortName)) !== undefined;
            return {
                projectPath: p.Path,
                outputPath: p.TargetPath,
                projectName: `${path.basename(p.Path, '.csproj')} (${p.Path})`,
                targetsDotnetCore: targetsDotnetCore,
                isExe: p.IsExe,
                isWebProject: p.IsWebProject,
                isBlazorWebAssemblyHosted: p.IsBlazorWebAssemblyHosted,
                isBlazorWebAssemblyStandalone: p.IsBlazorWebAssemblyStandalone,
                isWebAssemblyProject: p.IsWebAssemblyProject,
                solutionPath: null,
            };
        });

        /**
         * Note: serverUtils.requestWorkspaceInformation only retrieves one folder for multi-root workspaces. Therefore, generator will be incorrect for all folders
         * except the first in a workspace. Currently, this only works if the requested folder is the same as the server's solution path or folder.
         */
        const projectsInWorkspace = projects?.filter((p) => {
            // Get absolute paths of current folder and server folder.
            const workspaceFolder = path.resolve(workspacePath.fsPath);
            const projectFolder = path.dirname(p.projectPath);
            return isSubfolderOf(projectFolder, workspaceFolder);
        });
        return projectsInWorkspace;
    }
}
