import * as core from '@actions/core';
import {DotnetCoreInstaller} from './installer';
import * as fs from 'fs';
import path from 'path';
import semver from 'semver';
import * as auth from './authutil';
//import {isCacheFeatureAvailable} from './cache-utils';
import {restoreCache} from './cache-restore';
import {Outputs} from './constants';
import JSON5 from 'json5';

const qualityOptions = [
  'daily',
  'signed',
  'validated',
  'preview',
  'ga'
] as const;

export type QualityOptions = (typeof qualityOptions)[number];

export async function run() {
  try {
    const baseTag = 'v4.3.1';
    core.info(`sgnus-k8s/setup-dotnet@use-cache: based on actions/setup-dotnet@${baseTag}`);
    //
    // dotnet-version is optional, but needs to be provided for most use cases.
    // If supplied, install / use from the tool cache.
    // global-version-file may be specified to point to a specific global.json
    // and will be used to install an additional version.
    // If not supplied, look for version in ./global.json.
    // If a valid version still can't be identified, nothing will be installed.
    // Proxy, auth, (etc) are still set up, even if no version is identified
    //
    const versions = core.getMultilineInput('dotnet-version');
    const installedDotnetVersions: (string | null)[] = [];

    const globalJsonFileInput = core.getInput('global-json-file');
    if (globalJsonFileInput) {
      const globalJsonPath = path.resolve(process.cwd(), globalJsonFileInput);
      if (!fs.existsSync(globalJsonPath)) {
        throw new Error(
          `The specified global.json file '${globalJsonFileInput}' does not exist`
        );
      }
      versions.push(getVersionFromGlobalJson(globalJsonPath));
    }

    if (!versions.length) {
      // Try to fall back to global.json
      core.debug('No version found, trying to find version from global.json');
      const globalJsonPath = path.join(process.cwd(), 'global.json');
      if (fs.existsSync(globalJsonPath)) {
        versions.push(getVersionFromGlobalJson(globalJsonPath));
      } else {
        core.info(
          `The global.json wasn't found in the root directory. No .NET version will be installed.`
        );
      }
    }

    if (versions.length) {
      const quality = core.getInput('dotnet-quality') as QualityOptions;

      if (quality && !qualityOptions.includes(quality)) {
        throw new Error(
          `Value '${quality}' is not supported for the 'dotnet-quality' option. Supported values are: daily, signed, validated, preview, ga.`
        );
      }

      let dotnetInstaller: DotnetCoreInstaller;
      const uniqueVersions = new Set<string>(versions);
      // TODO:
      // Multiple versions requested may not be handled properly...
      // Standard dotnet installer places multiple versions in a single dir,
      // while tool-cache expects versions to be in separate dirs.
      // Stick to consistent tool-cache structure?
      // Or use standard dotnet installer structure as exception?
      // Best to only specify one version for now.
      for (const version of uniqueVersions) {
        dotnetInstaller = new DotnetCoreInstaller(version, quality);
        const installedVersion = await dotnetInstaller.installDotnet();
        core.addPath(process.env['DOTNET_INSTALL_DIR']!);
        core.info(`added ${process.env['DOTNET_INSTALL_DIR']} to path`);
        installedDotnetVersions.push(installedVersion);
      }
      // move the path addition into the loop to handle multiple versions
      // in separate tool-cache install dirs.
      //DotnetInstallDir.addToPath();
      // set DOTNET_ROOT to last-found installed version
      core.exportVariable('DOTNET_ROOT', process.env['DOTNET_INSTALL_DIR']);
      core.info(`set DOTNET_ROOT to ${process.env['DOTNET_ROOT']}`);
      core.exportVariable('DOTNET_NOLOGO', 'true');
      core.info(`set DOTNET_NOLOGO to ${process.env['DOTNET_NOLOGO']}`);
      core.exportVariable('NUGET_PACKAGES', path.join(process.env['HOME'] + '', '.nuget', 'packages'));
      core.info(`set NUGET_PACKAGES to ${process.env['NUGET_PACKAGES']}`);
    }

    const sourceUrl: string = core.getInput('source-url');
    const configFile: string = core.getInput('config-file');
    if (sourceUrl) {
      auth.configAuthentication(sourceUrl, configFile);
    }

    outputInstalledVersion(installedDotnetVersions, globalJsonFileInput);

    if (core.getBooleanInput('cache')) {
      const cacheDependencyPath = core.getInput('cache-dependency-path');
      await restoreCache(cacheDependencyPath);
    }

    const matchersPath = path.join(__dirname, '..', '..', '.github');
    core.info(`##[add-matcher]${path.join(matchersPath, 'csc.json')}`);
  } catch (error) {
    core.setFailed(error.message);
  }
}

function getVersionFromGlobalJson(globalJsonPath: string): string {
  let version = '';
  const globalJson = JSON5.parse(
    // .trim() is necessary to strip BOM https://github.com/nodejs/node/issues/20649
    fs.readFileSync(globalJsonPath, {encoding: 'utf8'}).trim(),
    // is necessary as JSON5 supports wider variety of options for numbers: https://www.npmjs.com/package/json5#numbers
    (key, value) => {
      if (key === 'version' || key === 'rollForward') return String(value);
      return value;
    }
  );
  if (globalJson.sdk && globalJson.sdk.version) {
    version = globalJson.sdk.version;
    const rollForward = globalJson.sdk.rollForward;
    if (rollForward && rollForward === 'latestFeature') {
      const [major, minor] = version.split('.');
      version = `${major}.${minor}`;
    }
  }
  return version;
}

function outputInstalledVersion(
  installedVersions: (string | null)[],
  globalJsonFileInput: string
): void {
  if (!installedVersions.length) {
    core.info(`The '${Outputs.DotnetVersion}' output will not be set.`);
    return;
  }

  if (installedVersions.includes(null)) {
    core.warning(
      `Failed to output the installed version of .NET. The '${Outputs.DotnetVersion}' output will not be set.`
    );
    return;
  }

  if (globalJsonFileInput) {
    const versionToOutput = installedVersions.at(-1); // .NET SDK version parsed from the global.json file is installed last
    core.setOutput(Outputs.DotnetVersion, versionToOutput);
    return;
  }

  const versionToOutput = semver.maxSatisfying(
    installedVersions as string[],
    '*',
    {
      includePrerelease: true
    }
  );

  core.setOutput(Outputs.DotnetVersion, versionToOutput);
}

run();
