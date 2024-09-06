/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import execa = require('execa');
import { promises, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import * as vscode from 'vscode';
import { ChromeBrowserFinder, EdgeBrowserFinder } from '@vscode/js-debug-browsers';
import { RazorLogger } from '../razorLogger';
import { ONLY_JS_DEBUG_NAME, MANAGED_DEBUG_NAME, JS_DEBUG_NAME, SERVER_APP_NAME } from './constants';
import { onDidTerminateDebugSession } from './terminateDebugHandler';
import showInformationMessage from '../../../shared/observers/utils/showInformationMessage';
import showErrorMessage from '../../../observers/utils/showErrorMessage';
import path = require('path');
import * as cp from 'child_process';
import { getExtensionPath } from '../../../common';
import { debugSessionTracker } from '../../../coreclrDebug/provisionalDebugSessionTracker';
import { getCSharpDevKit } from '../../../utils/getCSharpDevKit';
import Descriptors from '../../../lsptoolshost/services/descriptors';
import { CancellationToken } from 'vscode';
import { IDisposable, IObserver } from '@microsoft/servicehub-framework';
import { EventEmitter } from 'events';

export interface Project {
    Id: {
        ProjectPath: string;
        ProjectGuid?: string;
    };
    ActiveConfigurations?: [ProjectConfiguration];
}

export interface QueryResult<T> {
    Versions?: any;

    Items?: [T];
}

export interface ProjectConfiguration {
    BuildProperties?: any;
}

/**
 * This service provides implementation to execute a project query.
 */
export interface IQueryExecutionService {
    /**
     * execute a query.
     * @param query a query string.
     */
    ExecuteQueryAsync(query: string, cancellationToken?: CancellationToken): Promise<string>;

    /**
     * execute an update query.
     * @param query a query string.
     */
    ExecuteRemoteExecutableAsync(query: string, cancellationToken?: CancellationToken): Promise<string>;

    /**
     * Subscribe query results/
     * @param query a query string.
     * @param resultsReceiver an observer to receive results.
     */
    SubscribeQueryResultsAsync(
        query: string,
        resultsReceiver: IObserver<string>,
        cancellationToken?: CancellationToken
    ): Promise<IDisposable>;
}

export class BlazorDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    private static readonly autoDetectUserNotice: string = vscode.l10n.t(
        'Run and Debug: auto-detection found {0} for a launch browser'
    );
    private static readonly edgeBrowserType: string = 'msedge';
    private static readonly chromeBrowserType: string = 'chrome';
    private static readonly pidsByUrl = new Map<string, number | undefined>();
    private static readonly vsWebAssemblyBridgeOutputChannel = vscode.window.createOutputChannel('VsWebAssemblyBridge');

    constructor(private readonly logger: RazorLogger, private readonly vscodeType: typeof vscode) {}

    public async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        configuration: vscode.DebugConfiguration
    ): Promise<vscode.DebugConfiguration | undefined> {
        /**
         * The Blazor WebAssembly app should only be launched if the
         * launch configuration is a launch request. Attach requests will
         * only launch the browser.
         */
        if (configuration.request === 'launch') {
            await this.launchApp(folder, configuration);
        }

        let inspectUri =
            '{wsProtocol}://{url.hostname}:{url.port}/_framework/debug/ws-proxy?browser={browserInspectUri}';
        let url = 'https://localhost:5001';
        try {
            if (folder !== undefined) {
                let folderPath = configuration.cwd ? configuration.cwd : fileURLToPath(folder.uri.toString());
                folderPath = folderPath.replace('${workspaceFolder}', fileURLToPath(folder.uri.toString()));
                const launchSettings = JSON.parse(
                    readFileSync(join(folderPath, 'Properties', 'launchSettings.json'), 'utf8')
                );
                if (
                    launchSettings?.profiles &&
                    launchSettings?.profiles[Object.keys(launchSettings.profiles)[0]]?.inspectUri
                ) {
                    inspectUri = launchSettings.profiles[Object.keys(launchSettings.profiles)[0]].inspectUri;
                    url = launchSettings.profiles[Object.keys(launchSettings.profiles)[0]].applicationUrl.split(
                        ';',
                        1
                    )[0];
                }
            }
        } catch (error: any) {
            this.logger.logError(
                '[DEBUGGER] Error while getting information from launchSettings.json: ',
                error as Error
            );
        }

        await this.launchBrowser(folder, configuration, inspectUri, url);

        /**
         * If `resolveDebugConfiguration` returns undefined, then the debugger
         * launch is canceled. Here, we opt to manually launch the browser
         * configuration using `startDebugging` above instead of returning
         * the configuration to avoid a bug where VS Code is unable to resolve
         * the debug adapter for the browser debugger.
         */
        return undefined;
    }

    private async launchApp(folder: vscode.WorkspaceFolder | undefined, configuration: vscode.DebugConfiguration) {
        const program = configuration.hosted ? configuration.program : 'dotnet';
        const cwd = configuration.cwd || '${workspaceFolder}';
        const args = configuration.hosted ? [] : ['run'];

        const app = {
            name: SERVER_APP_NAME,
            type: 'coreclr',
            request: 'launch',
            prelaunchTask: 'build',
            program,
            args,
            cwd,
            env: {
                ASPNETCORE_ENVIRONMENT: 'Development',
                DOTNET_MODIFIABLE_ASSEMBLIES: 'debug',
                ...configuration.env,
            },
            launchBrowser: {
                enabled: false,
            },
            cascadeTerminateToConfigurations: [ONLY_JS_DEBUG_NAME, MANAGED_DEBUG_NAME, JS_DEBUG_NAME],
            ...configuration.dotNetConfig,
        };

        try {
            await this.vscodeType.debug.startDebugging(folder, app);
            if (process.platform !== 'win32') {
                const terminate = this.vscodeType.debug.onDidTerminateDebugSession(async (event) => {
                    const blazorDevServer = 'blazor-devserver\\.dll';
                    const dir = folder && folder.uri && folder.uri.fsPath;
                    const regexEscapedDir = dir!.toLowerCase()!.replace(/\//g, '\\/');
                    const launchedApp = configuration.hosted
                        ? app.program
                        : `${regexEscapedDir}.*${blazorDevServer}|${blazorDevServer}.*${regexEscapedDir}`;
                    await onDidTerminateDebugSession(event, this.logger, launchedApp);
                    terminate.dispose();
                });
            }
        } catch (error) {
            this.logger.logError('[DEBUGGER] Error when launching application: ', error as Error);
        }
    }

    private async launchBrowser(
        folder: vscode.WorkspaceFolder | undefined,
        configuration: vscode.DebugConfiguration,
        inspectUri: string,
        url: string
    ) {
        const originalInspectUri = inspectUri;
        let folderPath = configuration.cwd;
        if (folder && folderPath) {
            folderPath = folderPath.replace('${workspaceFolder}', fileURLToPath(folder.uri.toString()));
            folderPath = folderPath.replaceAll(/[\\/]/g, path.sep);
        }
        const useVSDbg = await BlazorDebugConfigurationProvider.useVSDbg(folderPath ? folderPath : '');
        let portBrowserDebug = -1;
        if (useVSDbg) {
            [inspectUri, portBrowserDebug] = await this.attachToAppOnBrowser(folder, configuration, url);
        }

        const configBrowser = configuration.browser;
        const browserType =
            configBrowser === 'edge'
                ? BlazorDebugConfigurationProvider.edgeBrowserType
                : configBrowser === 'chrome'
                ? BlazorDebugConfigurationProvider.chromeBrowserType
                : await BlazorDebugConfigurationProvider.determineBrowserType();
        if (!browserType) {
            return;
        }

        const browser = {
            name: useVSDbg ? ONLY_JS_DEBUG_NAME : JS_DEBUG_NAME,
            type: browserType,
            request: 'launch',
            timeout: configuration.timeout || 30000,
            url: configuration.url || url,
            webRoot: configuration.webRoot || '${workspaceFolder}',
            inspectUri,
            trace: configuration.trace || false,
            noDebug: configuration.noDebug || false,
            ...configuration.browserConfig,
            // When the browser debugging session is stopped, propogate
            // this and terminate the debugging session of the Blazor dev server.
            cascadeTerminateToConfigurations: [SERVER_APP_NAME, MANAGED_DEBUG_NAME],
        };

        if (useVSDbg) {
            browser.port = portBrowserDebug;
        }

        const monovsdbgSession = debugSessionTracker.getDebugSessionByType('monovsdbg');
        if (useVSDbg) {
            //means that we don't have c#devkit installed so we get information from configSettings
            if (monovsdbgSession === undefined && getCSharpDevKit() === undefined) {
                //something wrong happened kill the vswebassembly and use the older debugger
                browser.inspectUri = originalInspectUri;
                browser.port = undefined;
                const oldPid = BlazorDebugConfigurationProvider.pidsByUrl.get(browser.url);
                if (oldPid != undefined) {
                    process.kill(oldPid);
                }
            }
        }

        try {
            /**
             * The browser debugger will immediately launch after the
             * application process is started. It waits a `timeout`
             * interval before crashing after being unable to find the launched
             * process.
             *
             * We do this to provide immediate visual feedback to the user
             * that their debugger session has started.
             */
            await this.vscodeType.debug.startDebugging(folder, browser);
        } catch (error) {
            this.logger.logError('[DEBUGGER] Error when launching browser debugger: ', error as Error);
            const message = vscode.l10n.t(
                'There was an unexpected error while launching your debugging session. Check the console for helpful logs and visit the debugging docs for more info.'
            );
            const viewDebugDocsButton = vscode.l10n.t('View Debug Docs');
            const ignoreButton = vscode.l10n.t('Ignore');
            this.vscodeType.window.showErrorMessage(message, viewDebugDocsButton, ignoreButton).then(async (result) => {
                if (result === viewDebugDocsButton) {
                    const debugDocsUri = 'https://aka.ms/blazorwasmcodedebug';
                    await this.vscodeType.commands.executeCommand(`vcode.open`, debugDocsUri);
                }
            });
        }
    }

    private async attachToAppOnBrowser(
        folder: vscode.WorkspaceFolder | undefined,
        configuration: vscode.DebugConfiguration,
        url: string
    ): Promise<[string, number]> {
        const [inspectUriRet, portICorDebug, portBrowserDebug] =
            await BlazorDebugConfigurationProvider.launchVsWebAssemblyBridge(configuration.url || url);

        const cwd = configuration.cwd || '${workspaceFolder}';
        const args = configuration.hosted ? [] : ['run'];
        const app = {
            name: MANAGED_DEBUG_NAME,
            type: 'monovsdbg',
            request: 'launch',
            args,
            cwd,
            cascadeTerminateToConfigurations: [ONLY_JS_DEBUG_NAME, SERVER_APP_NAME, JS_DEBUG_NAME],
            ...configuration.dotNetConfig,
        };

        app.monoDebuggerOptions = {
            ip: '127.0.0.1',
            port: portICorDebug,
            platform: 'browser',
            isServer: true,
        };

        try {
            await this.vscodeType.debug.startDebugging(folder, app);
            const terminate = this.vscodeType.debug.onDidTerminateDebugSession(async (event) => {
                if (process.platform !== 'win32') {
                    const blazorDevServer = 'blazor-devserver\\.dll';
                    const dir = folder && folder.uri && folder.uri.fsPath;
                    const regexEscapedDir = dir!.toLowerCase()!.replace(/\//g, '\\/');
                    const launchedApp = configuration.hosted
                        ? app.program
                        : `${regexEscapedDir}.*${blazorDevServer}|${blazorDevServer}.*${regexEscapedDir}`;
                    await onDidTerminateDebugSession(event, this.logger, launchedApp);
                    terminate.dispose();
                }
                this.vscodeType.debug.stopDebugging();
            });
        } catch (error) {
            this.logger.logError('[DEBUGGER] Error when launching application: ', error as Error);
        }
        return [inspectUriRet, portBrowserDebug];
    }

    private static async launchVsWebAssemblyBridge(urlStr: string): Promise<[string, number, number]> {
        const dotnetPath = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
        const devToolsUrl = `http://localhost:0`; // Browser debugging port address
        const spawnedProxyArgs = [
            `${BlazorDebugConfigurationProvider.getWebAssemblyWebBridgePath()}`,
            '--DevToolsUrl',
            `${devToolsUrl}`,
            '--UseVsDbg',
            'true',
            '--iCorDebugPort',
            '-1',
            '--OwnerPid',
            `${process.pid}`,
        ];
        const cpOptions: cp.SpawnOptionsWithoutStdio = {
            detached: true,
            windowsHide: true,
        };
        let chunksProcessed = 0;
        let proxyICorDebugPort = -1;
        let proxyBrowserPort = -1;
        let newUri = '';
        const spawnedProxy = cp.spawn(dotnetPath, spawnedProxyArgs, cpOptions);
        const eventEmmiter = new EventEmitter();
        function handleData(stream: NodeJS.ReadableStream) {
            stream.on('data', (chunk) => {
                BlazorDebugConfigurationProvider.vsWebAssemblyBridgeOutputChannel.appendLine(chunk.toString());
                if (newUri != '') {
                    return;
                }
                if (chunksProcessed++ > 10) {
                    eventEmmiter.emit('vsWebAssemblyReady');
                }
                const matchExprProxyUrl = 'Now listening on: (?<url>.*)';
                const matchExprICorDebugPort = 'Listening iCorDebug on: (?<port>.*)';
                const matchExprBrowserPort = 'Waiting for browser on: (?<port>.*)';
                const foundProxyUrl = `${chunk}`.match(matchExprProxyUrl);
                const foundICorDebugPort = `${chunk}`.match(matchExprICorDebugPort);
                const foundBrowserPort = `${chunk}`.match(matchExprBrowserPort);
                const proxyUrlString = foundProxyUrl?.groups?.url;
                if (foundICorDebugPort?.groups?.port != undefined) {
                    proxyICorDebugPort = Number(foundICorDebugPort?.groups?.port);
                }
                if (foundBrowserPort?.groups?.port != undefined) {
                    proxyBrowserPort = Number(foundBrowserPort?.groups?.port);
                }
                if (proxyUrlString) {
                    BlazorDebugConfigurationProvider.vsWebAssemblyBridgeOutputChannel.appendLine(
                        `Debugging proxy is running at: ${proxyUrlString}`
                    );
                    const oldPid = BlazorDebugConfigurationProvider.pidsByUrl.get(urlStr);
                    if (oldPid != undefined) {
                        process.kill(oldPid);
                    }
                    BlazorDebugConfigurationProvider.pidsByUrl.set(urlStr, spawnedProxy.pid);
                    const url = new URL(proxyUrlString);
                    newUri = `${url.protocol.replace(`http`, `ws`)}//${url.host}{browserInspectUriPath}`;
                    eventEmmiter.emit('vsWebAssemblyReady');
                }
            });

            stream.on('err', (err) => {
                BlazorDebugConfigurationProvider.vsWebAssemblyBridgeOutputChannel.appendLine(err.toString());
                eventEmmiter.emit('vsWebAssemblyReady');
            });
        }

        handleData(spawnedProxy.stdout);
        handleData(spawnedProxy.stderr);
        await new Promise((resolve) => eventEmmiter.once('vsWebAssemblyReady', resolve));
        return [newUri, proxyICorDebugPort, proxyBrowserPort];
    }

    private static async isNet9OrNewer(projectPath: string): Promise<boolean> {
        let isNet9OrNewer = false;
        const configurationsObject = {
            $properties: ['BuildProperties'],
            BuildProperties: {
                $properties: ['Id', 'Name', 'Value', 'StorageType'],
                $where: {
                    '&&': [
                        { '==': [{ '.': 'Name' }, 'TargetFramework'] },
                        { '==': [{ '.': 'StorageType' }, 'ProjectFile'] },
                    ],
                },
            },
        };
        const query = {
            context: 'Projects',
            query: {
                $properties: ['ActiveConfigurations', 'Path'],
                ActiveConfigurations: configurationsObject,
                $filter: { ProjectsByCapabilities: ['WebAssembly'] },
            },
        };
        let queryString = '';
        if (projectPath != '') {
            const query = {
                context: 'Projects',
                query: {
                    $properties: ['ActiveConfigurations', 'Path'],
                    ActiveConfigurations: configurationsObject,
                    $where: { startswith: [{ '.': 'Path' }, projectPath] },
                },
            };
            queryString = JSON.stringify(query);
        } else {
            queryString = JSON.stringify(query);
        }
        const proxy = await getCSharpDevKit()?.exports.serviceBroker.getProxy<IQueryExecutionService>(
            Descriptors.projectQueryExecutionService
        );
        if (!proxy) {
            throw new Error('Unable to obtain required service from C# Dev Kit.');
        }
        try {
            const result = await proxy.ExecuteQueryAsync(queryString);
            const queryResult = JSON.parse(result) as QueryResult<Project>;
            const pattern = /^net(\d+\.\d+)\b/;
            if (queryResult && queryResult.Items) {
                isNet9OrNewer = false;
                queryResult.Items.forEach((project) => {
                    project.ActiveConfigurations?.forEach((activeConfig) => {
                        const match = activeConfig.BuildProperties[0].Value.match(pattern);
                        if (match && match[1] >= 9) {
                            isNet9OrNewer = true;
                        }
                    });
                });
                return isNet9OrNewer;
            }
        } catch (err) {
            throw new Error('Exception while talking to proxy: ' + err);
        } finally {
            proxy?.dispose();
        }
        return isNet9OrNewer;
    }
    private static async useVSDbg(projectPath: string): Promise<boolean> {
        const wasmConfig = vscode.workspace.getConfiguration('csharp');
        const useVSDbg = wasmConfig.get<boolean>('wasm.debug.useVSDbg') == true;
        if (!useVSDbg) {
            return false;
        }
        const existWebAssemblyWebBridge = existsSync(BlazorDebugConfigurationProvider.getWebAssemblyWebBridgePath());
        const csharpDevKitExtension = getCSharpDevKit();
        let isNet9OrNewer = true;
        if (existWebAssemblyWebBridge && csharpDevKitExtension !== undefined) {
            isNet9OrNewer = await BlazorDebugConfigurationProvider.isNet9OrNewer(projectPath);
        }
        return useVSDbg && existWebAssemblyWebBridge && isNet9OrNewer;
    }

    private static getWebAssemblyWebBridgePath() {
        const vsWebAssemblyBridge = path.join(
            getExtensionPath(),
            '.vswebassemblybridge',
            'Microsoft.Diagnostics.BrowserDebugHost.dll'
        );
        return vsWebAssemblyBridge;
    }

    public static async tryToUseVSDbgForMono(urlStr: string, projectPath: string): Promise<[string, number, number]> {
        const useVSDbg = await BlazorDebugConfigurationProvider.useVSDbg(projectPath);

        if (useVSDbg) {
            const [inspectUri, portICorDebug, portBrowserDebug] =
                await BlazorDebugConfigurationProvider.launchVsWebAssemblyBridge(urlStr);

            return [inspectUri, portICorDebug, portBrowserDebug];
        }
        return ['', -1, -1];
    }

    public static async determineBrowserType(): Promise<string | undefined> {
        // There was no browser specified by the user, so we will do some auto-detection to find a browser,
        // favoring Edge if multiple valid options are installed.
        const edgeBrowserFinder = new EdgeBrowserFinder(process.env, promises, execa);
        const edgeInstallations = await edgeBrowserFinder.findAll();
        if (edgeInstallations.length > 0) {
            showInformationMessage(
                vscode,
                BlazorDebugConfigurationProvider.autoDetectUserNotice.replace('{0}', `'Edge'`)
            );

            return BlazorDebugConfigurationProvider.edgeBrowserType;
        }

        const chromeBrowserFinder = new ChromeBrowserFinder(process.env, promises, execa);
        const chromeInstallations = await chromeBrowserFinder.findAll();
        if (chromeInstallations.length > 0) {
            showInformationMessage(
                vscode,
                BlazorDebugConfigurationProvider.autoDetectUserNotice.replace('{0}', `'Chrome'`)
            );

            return BlazorDebugConfigurationProvider.chromeBrowserType;
        }

        showErrorMessage(
            vscode,
            vscode.l10n.t('Run and Debug: A valid browser is not installed. Please install Edge or Chrome.')
        );
        return undefined;
    }
}
