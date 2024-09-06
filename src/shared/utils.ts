/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs-extra';
import * as path from 'path';

export function findNetFrameworkTargetFramework(tfmShortNames: string[]): string | undefined {
    const regexp = new RegExp('^net[1-4]');
    return tfmShortNames.find((tf) => regexp.test(tf));
}

export function findNetCoreTargetFramework(tfmShortNames: string[]): string | undefined {
    return findNetCoreAppTargetFramework(tfmShortNames) ?? findModernNetFrameworkTargetFramework(tfmShortNames);
}

export function findNetCoreAppTargetFramework(tfmShortNames: string[]): string | undefined {
    return tfmShortNames.find((tf) => tf.startsWith('netcoreapp'));
}

export function findModernNetFrameworkTargetFramework(tfmShortNames: string[]): string | undefined {
    const regexp = new RegExp('^net[5-9]');
    let targetFramework = tfmShortNames.find((tf) => regexp.test(tf));

    // Shortname is being reported as net50 instead of net5.0
    if (targetFramework !== undefined && targetFramework.charAt(4) !== '.') {
        targetFramework = `${targetFramework.substring(0, 4)}.${targetFramework.substring(4)}`;
    }

    return targetFramework;
}

export function findNetStandardTargetFramework(tfmShortNames: string[]): string | undefined {
    return tfmShortNames.find((tf) => tf.startsWith('netstandard'));
}

export function isWebProject(projectPath: string): [boolean, boolean] {
    const projectFileText = fs.readFileSync(projectPath, 'utf8').toLowerCase();

    // Assume that this is an MSBuild project. In that case, look for the 'Sdk="Microsoft.NET.Sdk.Web"' attribute.
    // TODO: Have OmniSharp provide the list of SDKs used by a project and check that list instead.
    return [
        projectFileText.indexOf('sdk="microsoft.net.sdk.web"') >= 0,
        projectFileText.indexOf('sdk="microsoft.net.sdk.blazorwebassembly"') >= 0,
    ];
}

export async function isBlazorWebAssemblyProject(projectPath: string): Promise<boolean> {
    const projectDirectory = path.dirname(projectPath);
    const launchSettingsPath = path.join(projectDirectory, 'Properties', 'launchSettings.json');

    try {
        if (!fs.pathExistsSync(launchSettingsPath)) {
            return false;
        }

        const launchSettingContent = fs.readFileSync(launchSettingsPath);
        if (!launchSettingContent) {
            return false;
        }

        if (launchSettingContent.indexOf('"inspectUri"') > 0) {
            return true;
        }
    } catch {
        // Swallow IO errors from reading the launchSettings.json files
    }

    return false;
}

export function isBlazorWebAssemblyHosted(
    isExeProject: boolean,
    isWebProject: boolean,
    isProjectBlazorWebAssemblyProject: boolean,
    targetsDotnetCore: boolean
): boolean {
    if (!isProjectBlazorWebAssemblyProject) {
        return false;
    }

    if (!isExeProject) {
        return false;
    }

    if (!isWebProject) {
        return false;
    }

    if (targetsDotnetCore) {
        return false;
    }

    return true;
}
