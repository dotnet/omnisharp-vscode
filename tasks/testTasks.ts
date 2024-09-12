/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as gulp from 'gulp';
import * as path from 'path';
import { codeExtensionPath, rootPath, outPath } from './projectPaths';
import * as jest from 'jest';
import { Config } from '@jest/types';
import { jestOmniSharpUnitTestProjectName } from '../test/omnisharp/omnisharpUnitTests/jest.config';
import { jestUnitTestProjectName } from '../test/lsptoolshost/unitTests/jest.config';
import { razorTestProjectName } from '../test/razor/razorTests/jest.config';
import { jestArtifactTestsProjectName } from '../test/lsptoolshost/artifactTests/jest.config';
import { prepareVSCodeAndExecuteTests } from '../test/vscodeLauncher';

createUnitTestSubTasks();
createIntegrationTestSubTasks();
createOmniSharpTestSubTasks();

gulp.task('test:artifacts', async () => {
    runJestTest(jestArtifactTestsProjectName);
});

gulp.task('test', gulp.series('test:unit', 'test:integration'));

// TODO: Enable lsp integration tests once tests for unimplemented features are disabled.
gulp.task('omnisharptest', gulp.series('omnisharptest:unit', 'omnisharptest:integration:stdio'));

function createUnitTestSubTasks() {
    gulp.task('test:unit:csharp', async () => {
        await runJestTest(jestUnitTestProjectName);
    });

    gulp.task('test:unit:razor', async () => {
        runJestTest(razorTestProjectName);
    });

    gulp.task('test:unit', gulp.series('test:unit:csharp', 'test:unit:razor'));
}

async function createIntegrationTestSubTasks() {
    const integrationTestProjects = ['slnWithCsproj'];
    for (const projectName of integrationTestProjects) {
        gulp.task(`test:integration:csharp:${projectName}`, async () =>
            runIntegrationTest(projectName, path.join('lsptoolshost', 'integrationTests'), `[C#][${projectName}]`)
        );

        gulp.task(`test:integration:devkit:${projectName}`, async () =>
            runDevKitIntegrationTests(
                projectName,
                path.join('lsptoolshost', 'integrationTests'),
                `[DevKit][${projectName}]`
            )
        );
    }

    gulp.task(
        'test:integration:csharp',
        gulp.series(integrationTestProjects.map((projectName) => `test:integration:csharp:${projectName}`))
    );

    gulp.task(
        'test:integration:devkit',
        gulp.series(integrationTestProjects.map((projectName) => `test:integration:devkit:${projectName}`))
    );

    const razorIntegrationTestProjects = ['BasicRazorApp2_1'];
    for (const projectName of razorIntegrationTestProjects) {
        gulp.task(`test:razorintegration:${projectName}`, async () =>
            runIntegrationTest(
                projectName,
                path.join('razor', 'razorIntegrationTests'),
                `Razor Test Integration ${projectName}`
            )
        );
    }

    gulp.task(
        'test:razorintegration',
        gulp.series(razorIntegrationTestProjects.map((projectName) => `test:razorintegration:${projectName}`))
    );

    gulp.task(
        'test:integration',
        gulp.series('test:integration:csharp', 'test:integration:devkit', 'test:razorintegration')
    );
}

function createOmniSharpTestSubTasks() {
    gulp.task('omnisharptest:unit', async () => {
        await runJestTest(jestOmniSharpUnitTestProjectName);
    });

    const omnisharpIntegrationTestProjects = [
        'singleCsproj',
        'slnWithCsproj',
        'slnFilterWithCsproj',
        'BasicRazorApp2_1',
    ];

    for (const projectName of omnisharpIntegrationTestProjects) {
        gulp.task(`omnisharptest:integration:${projectName}:stdio`, async () =>
            runOmnisharpJestIntegrationTest(projectName, 'stdio', `[O#][${projectName}][STDIO]`)
        );
        gulp.task(`omnisharptest:integration:${projectName}:lsp`, async () =>
            runOmnisharpJestIntegrationTest(projectName, 'lsp', `[O#][${projectName}][LSP]`)
        );
        gulp.task(
            `omnisharptest:integration:${projectName}`,
            gulp.series(
                `omnisharptest:integration:${projectName}:stdio`,
                `omnisharptest:integration:${projectName}:lsp`
            )
        );
    }

    gulp.task(
        'omnisharptest:integration',
        gulp.series(omnisharpIntegrationTestProjects.map((projectName) => `omnisharptest:integration:${projectName}`))
    );
    gulp.task(
        'omnisharptest:integration:stdio',
        gulp.series(
            omnisharpIntegrationTestProjects.map((projectName) => `omnisharptest:integration:${projectName}:stdio`)
        )
    );
    gulp.task(
        'omnisharptest:integration:lsp',
        gulp.series(
            omnisharpIntegrationTestProjects.map((projectName) => `omnisharptest:integration:${projectName}:lsp`)
        )
    );
}

async function runOmnisharpJestIntegrationTest(testAssetName: string, engine: 'stdio' | 'lsp', suiteName: string) {
    const workspaceFile = `omnisharp${engine === 'lsp' ? '_lsp' : ''}_${testAssetName}.code-workspace`;
    const testFolder = path.join('test', 'omnisharp', 'omnisharpIntegrationTests');

    const env = {
        OSVC_SUITE: testAssetName,
        CODE_EXTENSIONS_PATH: codeExtensionPath,
        CODE_WORKSPACE_ROOT: rootPath,
        OMNISHARP_ENGINE: engine,
        OMNISHARP_LOCATION: process.env.OMNISHARP_LOCATION,
        CODE_DISABLE_EXTENSIONS: 'true',
    };

    await runJestIntegrationTest(testAssetName, testFolder, workspaceFile, suiteName, env);
}

async function runDevKitIntegrationTests(testAssetName: string, testFolderName: string, suiteName: string) {
    // Tests using C# Dev Kit tests are a bit different from the rest - we are not able to restart the Dev Kit server and there
    // are not easy APIs to use to know if the project is reloading due to workspace changes.
    // So we have to isolate the C# Dev Kit tests into smaller test runs (in this case, per file), where each run
    // launches VSCode and runs the tests in that file.
    console.log(`Searching for test files in ${testFolderName}`);
    const allFiles = fs
        .readdirSync(testFolderName, {
            recursive: true,
        })
        .filter((f) => typeof f === 'string');
    const devKitTestFiles = allFiles.filter((f) => f.endsWith('.test.ts'));
    console.log(`Running tests in ${devKitTestFiles.join(', ')}`);
    for (const testFileName of devKitTestFiles) {
        await runIntegrationTest(
            testAssetName,
            testFolderName,
            suiteName,
            `devkit_${testAssetName}.code-workspace`,
            testFileName
        );
    }
}

async function runIntegrationTest(
    testAssetName: string,
    testFolderName: string,
    suiteName: string,
    vscodeWorkspaceFileName = `${testAssetName}.code-workspace`,
    testFileName: string | undefined = undefined
) {
    const testFolder = path.join('test', testFolderName);
    const env: NodeJS.ProcessEnv = {};
    return await runJestIntegrationTest(
        testAssetName,
        testFolder,
        vscodeWorkspaceFileName,
        suiteName,
        env,
        testFileName
    );
}

/**
 * Runs jest based integration tests.
 * @param testAssetName the name of the test asset
 * @param testFolderName the relative path (from workspace root)
 * @param workspaceFileName the name of the vscode workspace file to use.
 * @param suiteName a unique name for the test suite being run.
 * @param env any environment variables needed.
 */
async function runJestIntegrationTest(
    testAssetName: string,
    testFolderName: string,
    workspaceFileName: string,
    suiteName: string,
    env: NodeJS.ProcessEnv = {},
    testFileName: string | undefined = undefined
) {
    const logDirectoryName = testFileName ? `${suiteName}_${testFileName}` : suiteName;
    // Delete any logs produced by a previous run of the same test suite.
    const logDirectoryPath = path.join(outPath, 'logs', logDirectoryName);
    await deleteDirectoryRetry(logDirectoryPath);
    // Delete any existing logs in the vscode log directory to ensure we only have logs for the current run.
    const vscodeLogOutputDirectory = path.join(rootPath, '.vscode-test', 'user-data', 'logs');
    await deleteDirectoryRetry(vscodeLogOutputDirectory);

    // Test assets are always in a testAssets folder inside the integration test folder.
    const assetsPath = path.join(rootPath, testFolderName, 'testAssets');
    if (!fs.existsSync(assetsPath)) {
        throw new Error(`Could not find test assets at ${assetsPath}`);
    }
    const workspacePath = path.join(assetsPath, testAssetName, '.vscode', workspaceFileName);
    if (!fs.existsSync(workspacePath)) {
        throw new Error(`Could not find vscode workspace to open at ${workspacePath}`);
    }

    // The runner (that loads in the vscode process to run tests) is in the test folder in the *output* directory.
    const vscodeRunnerPath = path.join(outPath, testFolderName, 'index.js');
    if (!fs.existsSync(vscodeRunnerPath)) {
        throw new Error(`Could not find vscode runner in out/ at ${vscodeRunnerPath}`);
    }

    // Configure the file and suite name in CI to avoid having multiple test runs stomp on each other.
    env.JEST_JUNIT_OUTPUT_NAME = getJUnitFileName(suiteName);
    env.JEST_SUITE_NAME = suiteName;

    if (testFileName) {
        console.log(`Running only tests in ${testFileName}`);
        process.env.TEST_FILE_FILTER = testFileName;
    }

    const result = await prepareVSCodeAndExecuteTests(rootPath, vscodeRunnerPath, workspacePath, env);

    // Copy the logs VSCode produced to the output log directory
    fs.cpSync(vscodeLogOutputDirectory, logDirectoryPath, { recursive: true });

    if (result > 0) {
        // Ensure that gulp fails when tests fail
        throw new Error(`Exit code: ${result}`);
    }

    return result;
}

async function runJestTest(project: string) {
    process.env.JEST_JUNIT_OUTPUT_NAME = getJUnitFileName(project);
    process.env.JEST_SUITE_NAME = project;
    const configPath = path.join(rootPath, 'jest.config.ts');
    const { results } = await jest.runCLI(
        {
            config: configPath,
            selectProjects: [project],
            verbose: true,
        } as Config.Argv,
        [project]
    );

    if (!results.success) {
        throw new Error('Tests failed.');
    }
}

function getJUnitFileName(suiteName: string) {
    return `${suiteName.replaceAll(' ', '_')}_junit.xml`;
}

/**
 * VSCode sometimes holds onto file locks after the main process has exited (for telemetry reporting).
 * So we attempt to delete the directory, wait 5 seconds, and then try again.
 */
async function deleteDirectoryRetry(directory: string) {
    if (!fs.existsSync(directory)) {
        return;
    }
    fs.rmSync(directory, { recursive: true, force: true });
    const delay = new Promise((res) => setTimeout(res, 5000));
    await delay;
    fs.rmSync(directory, { recursive: true, force: true });
}
