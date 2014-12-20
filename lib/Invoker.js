var pkg = require('../package.json');

var debug = require('debug')(pkg.name);
var path = require('path');
var fs = require('fs-extra');
var async = require('async');
var unflatten = require('flat').unflatten;
var _ = require('lodash');
var lockFile = require('lockfile');

var util = require('any2api-util');



module.exports = function(spec) {
  var obj = {};

  obj.invoke = function(args, done) {
    args = args || {};

    var apiSpec = args.apiSpec;
    if (!apiSpec) return done(new Error('API spec missing'));

    var params = args.parameters;
    if (!params) return done(new Error('parameters missing'));

    if (!params.run_list) return done(new Error('run_list parameter missing'));

    var config = params.invoker_config || {};

    config.access = config.access || 'local';
    config.min_runs = config.min_runs || 1;
    config.max_runs = config.max_runs || 3;

    var runParams = params._;
    delete params._;

    //runParams.run_id = runParams.run_id || uuid.v4();
    if (!runParams.run_path) return done(new Error('_.run_path parameter missing'));

    var runOutputDir = path.join(runParams.run_path, 'out');
    var baseDir = path.join('/', 'tmp', 'any2api-invoker-chef', runParams.executable_name);
    var chefStatusFile = path.join('/', 'opt', 'chef_installed');

    var executable = apiSpec.executables[runParams.executable_name];

    // Invoker status and remote access (local, SSH, ...)
    var invokerStatusFile = path.resolve(__dirname, '..', 'invoker-status.json');
    var invokerStatus = { hosts: {} };
    var access;
    var host = 'localhost';

    // Lock
    var lockWait = 5000;
    var lockFilePath = path.resolve(__dirname, 'invoker-status.lock');

    // Files and directories
    var origExecDir = path.resolve(apiSpec.apispec_path, '..', executable.path);
    var execDir = path.join(baseDir, 'executable');

    var chefDir = path.join(baseDir, 'chef_data');
    var cookbooksDir = path.join(baseDir, 'chef_data', 'cookbooks');
    var rolesDir = path.join(baseDir, 'chef_data', 'roles');

    var runStatusFile = path.join(baseDir, '.environment_installed');
    var chefConfigFile = path.join(baseDir, 'chef.rb');
    var runListFile = path.join(baseDir, 'run_list.json');

    var chefConfig = [
      'file_cache_path "' + chefDir + '"',
      'cookbook_path [ "' + cookbooksDir + '" ]',
      'role_path "' + rolesDir + '"'
    ].join('\n');

    var commands = {
      install: [
        'if type apt-get > /dev/null; then sudo apt-get -y update && sudo apt-get -y install curl; fi',
        'if type yum > /dev/null; then sudo yum -y install curl; fi',
        'curl -L https://www.opscode.com/chef/install.sh | sudo bash'
      ].join(' && '),
      run: 'sudo chef-solo -c ' + chefConfigFile + ' -j ' + runListFile
    };



    var prepare = function(done) {
      if (config.access === 'local') {
        access = require('any2api-access').Local(config);
      } else if (config.access === 'ssh') {
        access = require('any2api-access').SSH(config);

        host = config.ssh_host;
      } else {
        return done(new Error('access \'' + config.access + '\' not supported'));
      }

      async.series([
        async.apply(lockFile.lock, lockFilePath, { wait: lockWait }),
        function(callback) {
          if (!fs.existsSync(invokerStatusFile)) return callback();

          fs.readFile(invokerStatusFile, 'utf8', function(err, content) {
            if (err) return callback(err);

            invokerStatus = JSON.parse(content);

            callback();
          });
        },
        function(callback) {
          if (invokerStatus.hosts[host]) {
            var err = new Error('Chef invoker already running on ' + host);
            host = null;

            return callback(err);
          }

          invokerStatus.hosts[host] = 'running';

          callback();
        },
        async.apply(fs.writeFile, invokerStatusFile, JSON.stringify(invokerStatus), 'utf8'),
        async.apply(lockFile.unlock, lockFilePath)
      ], done);
    };

    var install = function(done) {
      var cookbookName = executable.cookbook_name;

      var metadataPath = path.resolve(origExecDir, 'metadata.json');

      if (!cookbookName && fs.existsSync(metadataPath)) {
        var metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

        if (metadata.name) cookbookName = metadata.name;
      }

      if (!cookbookName) return done(new Error('cookbook name cannot be determined'));

      var cookbookDir = path.join(cookbooksDir, cookbookName);

      executable.dependencies_subdir = executable.dependencies_subdir || 'cookbook_dependencies';

      async.series([
        async.apply(access.remove, { path: baseDir }),
        async.apply(access.mkdir, { path: baseDir }),
        async.apply(access.mkdir, { path: chefDir }),
        //async.apply(access.mkdir, { path: cookbooksDir }),
        async.apply(access.mkdir, { path: rolesDir }),
        async.apply(access.copyDirToRemote, { sourcePath: origExecDir, targetPath: execDir }),
        async.apply(access.writeFile, { path: chefConfigFile, content: chefConfig }),
        async.apply(access.mkdir, { path: path.join(execDir, executable.dependencies_subdir, '..') }),
        async.apply(access.move, { sourcePath: path.join(execDir, executable.dependencies_subdir), targetPath: cookbooksDir }),
        function(callback) {
          access.mkdir({ path: cookbookDir }, callback);
        },
        function(callback) {
          access.copy({ sourcePath: execDir, targetPath: cookbookDir }, callback);
        },
        //function(callback) {
        //  access.remove({ path: path.join(cookbookDir, executable.dependencies_subdir) }, callback);
        //},
        function(callback) {
          access.exists({ path: chefStatusFile }, function(err, exists) {
            if (err) callback(err);
            else if (exists) done();
            else callback();
          });
        },
        function(callback) {
          access.exec({ command: commands.install }, function(err, stdout, stderr) {
            if (stderr) console.error(stderr);
            if (stdout) console.log(stdout);

            if (err) {
              err.stderr = stderr;
              err.stdout = stdout;

              return callback(err);
            }

            access.writeFile({ path: chefStatusFile, content: 'installed' }, callback);
          });
        },
        async.apply(access.writeFile, { path: runStatusFile, content: 'installed' })
      ], done);
    };

    var run = function(done) {
      var runs = 0;
      var success = false;

      var attributes = unflatten(params, { delimiter: '/' });

      access.writeFile({ path: runListFile, content: JSON.stringify(attributes) }, function(err) {
        async.whilst(function() {
          return !success && runs < config.max_runs;
        }, function(done) {
          runs++;

          access.exec({ command: commands.run }, function(err, stdout, stderr) {
            if (stderr) console.error(stderr);
            if (stdout) console.log(stdout);

            if ((err && runs < config.max_runs) || runs < config.min_runs) {
              return done();
            } else if (err) {
              err.stderr = stderr;
              err.stdout = stdout;

              return done(err);
            } else {
              success = true;

              console.log('Number of runs:', runs);

              var psOutput;

              // Write outputs
              async.series([
                async.apply(fs.mkdirs, runOutputDir),
                async.apply(fs.writeFile, path.resolve(runOutputDir, 'run_list.json'), JSON.stringify(attributes)),
                function(callback) {
                  access.exec({ command: 'ps aux' }, function(err, stdout, stderr) {
                    psOutput = stdout;

                    callback(err);
                  });
                },
                function(callback) {
                  fs.writeFile(path.resolve(runOutputDir, 'ps_aux.txt'), psOutput, callback);
                },
                async.apply(util.collectResults, { apiSpec: apiSpec,
                                                   executable_name: runParams.executable_name,
                                                   localPath: runParams.run_path,
                                                   remotePath: execDir,
                                                   access: access })
              ], done);
            }
          });
        }, done);
      });
    };



    async.series([
      async.apply(prepare),
      function(callback) {
        access.exists({ path: runStatusFile }, function(err, exists) {
          if (err) callback(err);
          else if (!exists) install(callback);
          else callback();
        });
      },
      async.apply(run)
    ], function(err) {
      async.series([
        //async.apply(access.remove, { path: baseDir }),
        async.apply(access.terminate),
        async.apply(lockFile.lock, lockFilePath, { wait: lockWait }),
        function(callback) {
          if (!host) return callback();

          invokerStatus = JSON.parse(fs.readFileSync(invokerStatusFile, 'utf8'));

          delete invokerStatus.hosts[host];

          fs.writeFileSync(invokerStatusFile, JSON.stringify(invokerStatus), 'utf8');

          callback();
        },
        async.apply(lockFile.unlock, lockFilePath)
      ], function(err2) {
        //TODO merge err with err2 using VError
        if (err2) console.error(err2);

        done(err);
      });
    });
  };

  return obj;
};
