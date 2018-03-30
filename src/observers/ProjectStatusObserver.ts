/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DocumentFilter, DocumentSelector, StatusBarItem, vscode } from '../vscodeAdapter';
import { basename } from 'path';
import { OmnisharpServerOnServerError, BaseEvent, OmnisharpOnMultipleLaunchTargets, OmnisharpOnBeforeServerInstall, OmnisharpOnBeforeServerStart, ActiveTextEditorChanged, OmnisharpServerOnStop, OmnisharpServerOnStart, WorkspaceInformationUpdated } from "../omnisharp/loggingEvents";
export class OmnisharpStatusBarObserver {
    constructor(private vscode: vscode, private statusBarItem: StatusBarItem) {
    }
/* Notes: Since we have removed the listeners and the disposables from the server start and stop event, 
we will not show up the status bar item :) 
*/
    public post = (event: BaseEvent) => {
        switch (event.constructor.name) {
            case OmnisharpOnMultipleLaunchTargets.name:
                SetStatus(this.defaultStatus, '$(flame) Select project', 'o.pickProjectAndStart', 'rgb(90, 218, 90)');
                this.render();
                break;
            case ActiveTextEditorChanged.name:
                this.render();
                break;
            case OmnisharpServerOnStop.name:
                this.projectStatus = undefined;
                this.defaultStatus.text = undefined;
                break;
            case OmnisharpServerOnStart.name:
                SetStatus(this.defaultStatus, '$(flame) Running', 'o.pickProjectAndStart', '');
                this.render();
                break;
            case WorkspaceInformationUpdated.name:
                this.handleWorkspaceInformationUpdated(<WorkspaceInformationUpdated>event);
        }
    }

    private handleWorkspaceInformationUpdated(event: WorkspaceInformationUpdated) {
        interface Project {
            Path: string;
            SourceFiles: string[];
        }

        let fileNames: DocumentFilter[] = [];
        let label: string;

        function addProjectFileNames(project: Project) {
            fileNames.push({ pattern: project.Path });

            if (project.SourceFiles) {
                for (let sourceFile of project.SourceFiles) {
                    fileNames.push({ pattern: sourceFile });
                }
            }
        }

        let info = event.info;
        // show sln-file if applicable
        if (info.MsBuild && info.MsBuild.SolutionPath) {
            label = basename(info.MsBuild.SolutionPath); //workspace.getRelativePath(info.MsBuild.SolutionPath);
            fileNames.push({ pattern: info.MsBuild.SolutionPath });

            for (let project of info.MsBuild.Projects) {
                addProjectFileNames(project);
            }
        }

        // set project info
        this.projectStatus = new Status(fileNames);
        SetStatus(this.projectStatus, '$(flame) ' + label, 'o.pickProjectAndStart');
        SetStatus(this.defaultStatus, '$(flame) Switch projects', 'o.pickProjectAndStart');
        this.render();
    }

    private render = () => {
        let activeTextEditor = this.vscode.window.activeTextEditor;
        if (!activeTextEditor) {
            this.statusBarItem.hide();
            return;
        }

        let document = activeTextEditor.document;
        let status: Status;

        if (this.projectStatus && this.vscode.languages.match(this.projectStatus.selector, document)) {
            status = this.projectStatus;
        } else if (this.defaultStatus.text && this.vscode.languages.match(this.defaultStatus.selector, document)) {
            status = this.defaultStatus;
        }

        if (status) {
            this.statusBarItem.text = status.text;
            this.statusBarItem.command = status.command;
            this.statusBarItem.color = status.color;
            this.statusBarItem.show();
            return;
        }

        this.statusBarItem.hide();
    }

    private SetAndRenderStatusBar(text: string, command: string, color?: string) {
        this.statusBarItem.text = text;
        this.statusBarItem.command = command;
        this.statusBarItem.color = color;
        this.statusBarItem.show();
    }
}