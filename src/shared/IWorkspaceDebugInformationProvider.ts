/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri } from 'vscode';

export interface IWorkspaceDebugInformationProvider {
    /**
     * Get information from the workspace required to create and manage debug configurations.
     */
    getWorkspaceDebugInformation(workspacePath: Uri): Promise<ProjectDebugInformation[] | undefined>;
}

export interface ProjectDebugInformation {
    /**
     * The absolute path to the project file.
     */
    projectPath: string;

    /**
     * The absolute path to the solution file.
     */
    solutionPath: string | null;
    /**
     * The absolute path to the output assembly dll.
     */
    outputPath: string;

    /**
     * Project name that shows up in the configuration picker.
     */
    projectName: string;

    /**
     * The short names of the target frameworks, e.g. net7.0
     */
    targetsDotnetCore: boolean;

    /**
     * Whether the project is executable.
     */
    isExe: boolean;

    /**
     * If this is a web project.
     */
    isWebProject: boolean;

    /**
     * If this is a hosted blazor web assembly project.
     */
    isBlazorWebAssemblyHosted: boolean;

    /**
     * If this is a standalone blazor web assembly project.
     */
    isBlazorWebAssemblyStandalone: boolean;

    /**
     * If this is a web assembly project.
     */
    isWebAssemblyProject: boolean;
}
