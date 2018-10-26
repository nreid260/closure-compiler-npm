#!/usr/bin/env node
/*
 * Copyright 2018 The Closure Compiler Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';
/**
 * @fileoverview
 *
 * Build the graal native compiler image for the current OS.
 * Intended to be run with a working directory of the intended package.
 */

const {spawn} = require('child_process');
const fs = require('fs');
const path = require('path');
const ncp = require('ncp');
const {
  GRAAL_OS,
  GRAAL_FOLDER,
  GRAAL_VERSION,
  GRAAL_URL
} = require('./graal-env');
const TEMP_PATH = path.resolve(__dirname, '../temp');

// This script should catch and handle all rejected promises.
// If it ever fails to do so, report that and exit immediately.
process.on('unhandledRejection', error => {
  console.error(error);
  process.exit(1);
});

// If this is a release build (not a nightly build), we have to build graal from source.
// As of the 20181008 release, the compiler was not compatible with any pre-built version of GRAAL.
//
// However, master is now compatible so nightly builds can use a pre-built graal.
const GRAAL_BUILD_FROM_SRC = !Boolean('COMPILER_NIGHTLY' in process.env);

/**
 * Simple wrapper for the NodeJS spawn command to use promises
 *
 * @param {string} command
 * @param {Object=} spawnOpts
 * @return {!Promise<undefined>}
 */
function runCommand(command, spawnOpts = {}) {
  // log command being executed to stdout for debugging
  process.stdout.write(`${command}\n`);
  return new Promise((resolve, reject) => {
    // TODO(ChadKillingsworth): Not really safe in general, since this could split in the middle of quoted strings.
    // This is good enough for the purposes of this script.
    const commandParts = command.split(/\s+/);
    // child process should inherit stdin/out/err from this process unless spawnOpts says otherwise
    const opts = Object.assign({}, {
      stdio: 'inherit'
    }, spawnOpts);
    const externalProcess = spawn(commandParts[0], commandParts.slice(1), opts);
    externalProcess.on('error', err => {
      process.stderr.write(`${err.toString()}\n`);
      reject(err);
    });
    externalProcess.on('close', exitCode => {
      if (exitCode != 0) {
        process.stderr.write(`non zero exit code ${exitCode}\n`);
        process.exit(1);
        reject();
      }
      resolve();
    });
  });
}

// Build graal from source
if (!fs.existsSync(TEMP_PATH)) {
  fs.mkdirSync(TEMP_PATH);
}

const NATIVE_IMAGE_BUILD_ARGS = [
  '-H:+JNI',
  '--no-server',
  '-H:+ReportUnsupportedElementsAtRuntime',
  '-H:IncludeResourceBundles=com.google.javascript.rhino.Messages',
  '-H:IncludeResourceBundles=org.kohsuke.args4j.Messages',
  '-H:IncludeResourceBundles=org.kohsuke.args4j.spi.Messages',
  '-H:IncludeResourceBundles=com.google.javascript.jscomp.parsing.ParserConfig',
  `-H:ReflectionConfigurationFiles=${path.resolve(__dirname, 'reflection-config.json')}`,
  '-H:IncludeResources="(externs.zip)|(.*(js|txt))"',
  '-jar',
  path.resolve(process.cwd(), 'compiler.jar')
];
let buildSteps = Promise.resolve();
if (GRAAL_BUILD_FROM_SRC) {
  const GRAAL_SRC_BASE = path.resolve(TEMP_PATH, 'graal');
  const MX_SRC_BASE = path.resolve(TEMP_PATH, 'mx');

  // The JVMCI version is strongly tied to the Graal version. When Graal is updated, the newest JVMCI release
  // known to work should be used. This is often determined by trial and error.
  const JVMCI_VERSION = 'jvmci-0.44';
  const GRAAL_SOURCE_VERSION = 'vm-1.0.0-rc3';

  // Clone the graal and mx repositories
  buildSteps = buildSteps
      .then(() => {
        if (fs.existsSync(GRAAL_SRC_BASE)) {
          return runCommand('git fetch', {cwd: GRAAL_SRC_BASE});
        } else {
          return runCommand('git clone https://github.com/oracle/graal.git', {cwd: TEMP_PATH});
        }
      })
      .then(() => runCommand(`git checkout ${GRAAL_SOURCE_VERSION}`, {cwd: GRAAL_SRC_BASE}))
      .then(() => {
        if (!fs.existsSync(MX_SRC_BASE)) {
          return runCommand('git clone https://github.com/graalvm/mx.git', {cwd: TEMP_PATH});
        }
      });

  // Download the JDK with JVMCI support
  let JDK_URL;
  let JDK_FOLDER;
  let JDK_PATH;
  let JDK8_UPDATE_VERSION;
  if (process.platform === 'darwin') {
    // Custom built JDK8 with JVMCI support needed to build graal.
    // Newer versions officially released at https://github.com/graalvm/openjdk8-jvmci-builder/releases
    // were not compatible with the version of graal needed by the compiler.
    // This specific version is known to work with the specific graal release we build.
    // The JDK version is obtained from the JDK release url on GitHub.
    JDK8_UPDATE_VERSION = '181';
    JDK_URL =
        'https://github.com/ChadKillingsworth/openjdk8-jvmci-builder/releases/download/' +
        JVMCI_VERSION +
        '/jdk1.8.0_' +
        JDK8_UPDATE_VERSION +
        '-' +
        JVMCI_VERSION +
        '-' +
        process.platform +
        '-amd64.tar.gz';

    JDK_FOLDER = `jdk1.8.0_${JDK8_UPDATE_VERSION}-${JVMCI_VERSION}`;
    JDK_PATH = path.resolve(TEMP_PATH, JDK_FOLDER, 'Contents', 'Home');
  } else {
    // Custom built JDK8 with JVMCI support needed to build graal.
    // This specific version is known to work with the specific graal release we build.
    // The JDK version is obtained from the JDK release url on GitHub.
    JDK8_UPDATE_VERSION = '172';
    JDK_URL =
        'https://github.com/graalvm/openjdk8-jvmci-builder/releases/download/' +
        JVMCI_VERSION +
        '/openjdk-8u' +
        JDK8_UPDATE_VERSION +
        '-' +
        JVMCI_VERSION +
        '-' +
        process.platform +
        '-amd64.tar.gz';

    JDK_FOLDER = `openjdk1.8.0_${JDK8_UPDATE_VERSION}-${JVMCI_VERSION}`;
    JDK_PATH = path.resolve(TEMP_PATH, JDK_FOLDER);
  }
  buildSteps = buildSteps
      .then(() => {
        if (!fs.existsSync(path.resolve(TEMP_PATH, 'jdk.tar.gz'))) {
          return runCommand(
              `curl --fail --show-error --location --progress-bar --output ${JDK_FOLDER}.tar.gz ${JDK_URL}`,
              {cwd: TEMP_PATH});
        }
      })
      .then(() => runCommand(
          `tar -xzf ${JDK_FOLDER}.tar.gz`,
          {cwd: TEMP_PATH}));

  // Build the native image tool then use it to build the compiler native image.
  // Copy the resulting binary back to the package.
  //
  // At this point the temp folder should have:
  //   - a JDK folder with JVMCI support
  //   - an /mx folder with the mx build system
  //   - a /graal folder checked out to the proper commit
  buildSteps = buildSteps
      .then(() => runCommand(
          `${path.resolve(MX_SRC_BASE, 'mx')} -v --primary-suite-path substratevm build`,
          {
            cwd: GRAAL_SRC_BASE,
            env: Object.assign({}, process.env, {JAVA_HOME: JDK_PATH, EXTRA_JAVA_HOMES: JDK_PATH})
          }))
      .then(() =>
          // The mx launched version requires quotes around the arguments.
          // But to correctly handle the quotes, we need to use a native shell to properly escape and pass them
          // to the executable.
          runCommand(`${path.resolve(MX_SRC_BASE, 'mx')} -v native-image ${NATIVE_IMAGE_BUILD_ARGS.join(' ')}`, {
            cwd: path.resolve(GRAAL_SRC_BASE, 'substratevm'),
            env: Object.assign({}, process.env, {JAVA_HOME: JDK_PATH, EXTRA_JAVA_HOMES: JDK_PATH}),
            shell: true // Needed for proper quote escaping
          }))
      .then(() => new Promise((resolve, reject) =>
          ncp(
              path.resolve(GRAAL_SRC_BASE, 'substratevm', 'compiler'),
              path.resolve(process.cwd(), 'compiler'),
              err => err ? reject(err) : resolve())));
} else {
  // Download Graal
  const GRAAL_ARCHIVE_FILE = `${GRAAL_FOLDER}.tar.gz`;
  if (!fs.existsSync(path.resolve(TEMP_PATH, GRAAL_FOLDER))) {
    buildSteps = buildSteps
        .then(() => {
          // Download graal and extract the contents
          if (!fs.existsSync(path.resolve(TEMP_PATH, GRAAL_ARCHIVE_FILE))) {
            return runCommand(
                `curl --fail --show-error --location --progress-bar --output ${GRAAL_ARCHIVE_FILE} ${GRAAL_URL}`,
                {cwd: TEMP_PATH});
          }
        })
        .then(() => runCommand(`tar -xzf ${GRAAL_ARCHIVE_FILE}`, {cwd: TEMP_PATH}));
  }

  // Build the compiler native image.
  const GRAAL_NATIVE_IMAGE_PATH = path.resolve(
      TEMP_PATH,
      `graalvm-ce-${GRAAL_VERSION}`,
      ...(GRAAL_OS === 'macos' ? ['Contents', 'Home'] : []).concat(['bin', 'native-image']));

  // Unlike the mx launched version, the native binary must not have quotes around arguments
  buildSteps = buildSteps.then(
      () => runCommand(`${GRAAL_NATIVE_IMAGE_PATH} ${NATIVE_IMAGE_BUILD_ARGS.join(' ').replace(/"/g, '')}`));
}
