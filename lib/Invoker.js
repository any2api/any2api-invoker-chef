var path = require('path');
var fs = require('fs');
var async = require('async');
var unflatten = require('flat').unflatten;
//var _ = require('lodash');
var lockFile = require('lockfile');

var access = require('any2api-access');
var util = require('any2api-util');



// Invoker status and remote access (local, SSH, ...)
var invokerStatusFile = path.resolve(__dirname, '..', 'invoker-status.json');
var invokerStatus = { hosts: {} };
var host = 'localhost';

// Lock
var lockWait = 5000;
var lockFilePath = path.resolve(__dirname, 'invoker-status.lock');

var chefStatusFile = path.join('/', 'opt', 'chef_installed');



module.exports = util.createInvoker({
  accessModule: access,
  gatherParameters: [ { name: 'run_list' }, { mapping: 'cookbook_attribute' } ],
  invoke: function(ctx, callback) {
    if (!ctx.executable || !ctx.executablePath) return callback(new Error('executable (cookbook) missing'));

    if (!ctx.unmappedParameters.run_list) return callback(new Error('run_list parameter missing'));

    ctx.mappedParameters.cookbook_attribute = ctx.mappedParameters.cookbook_attribute || {};

    var prepare = function(callback) {
      host = ctx.invokerConfig.ssh_host || host;

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
      ], callback);
    };

    var install = function(callback) {
      var cookbookName = ctx.executable.cookbook_name;

      var metadataPath = path.resolve(ctx.executablePath, 'metadata.json');

      if (!cookbookName && fs.existsSync(metadataPath)) {
        var metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

        if (metadata.name) cookbookName = metadata.name;
      }

      if (!cookbookName) return callback(new Error('cookbook name cannot be determined'));

      var cookbookDir = path.join(ctx.cookbooksDir, cookbookName);

      ctx.executable.dependencies_subdir = ctx.executable.dependencies_subdir || 'cookbook_dependencies';

      var chefConfig = [
        'file_cache_path "' + ctx.chefDir + '"',
        'cookbook_path [ "' + ctx.cookbooksDir + '" ]',
        'role_path "' + ctx.rolesDir + '"'
      ].join('\n');

      var installCommand = [
        'if type apt-get > /dev/null; then sudo apt-get -y update && sudo apt-get -y install curl; fi',
        'if type yum > /dev/null; then sudo yum -y install curl; fi',
        'curl -L https://www.opscode.com/chef/install.sh | sudo bash'
      ].join(' && ');

      async.series([
        //async.apply(ctx.access.remove, { path: baseDir }),
        //async.apply(ctx.access.mkdir, { path: baseDir }),
        async.apply(ctx.access.mkdir, { path: ctx.chefDir }),
        //async.apply(ctx.access.mkdir, { path: ctx.cookbooksDir }),
        async.apply(ctx.access.mkdir, { path: ctx.rolesDir }),
        async.apply(ctx.access.copyDirToRemote, { sourcePath: ctx.executablePath, targetPath: ctx.execDir }),
        async.apply(ctx.access.writeFile, { path: ctx.chefConfigFile, content: chefConfig }),
        async.apply(ctx.access.mkdir, { path: path.join(ctx.execDir, ctx.executable.dependencies_subdir, '..') }),
        async.apply(ctx.access.move, { sourcePath: path.join(ctx.execDir, ctx.executable.dependencies_subdir), targetPath: ctx.cookbooksDir }),
        function(callback) {
          ctx.access.mkdir({ path: cookbookDir }, callback);
        },
        function(callback) {
          ctx.access.move({ sourcePath: ctx.execDir, targetPath: cookbookDir }, callback);
        },
        async.apply(ctx.access.remove, { path: ctx.execDir }),
        //function(callback) {
        //  ctx.access.remove({ path: path.join(cookbookDir, ctx.executable.dependencies_subdir) }, callback);
        //},
        function(callback) {
          ctx.access.exists({ path: chefStatusFile }, function(err, exists) {
            if (err) callback(err);
            else if (exists) callback();
            else callback();
          });
        },
        function(callback) {
          ctx.access.exec({ command: installCommand }, ctx.accessExecCallback(function(err) {
            if (err) return callback(err);

            ctx.access.writeFile({ path: chefStatusFile, content: 'installed' }, callback);
          }));
        },
        async.apply(ctx.access.writeFile, { path: ctx.instanceStatusFile, content: 'installed' })
      ], callback);
    };

    var run = function(callback) {
      var runCommand = 'sudo chef-solo -c ' + ctx.chefConfigFile + ' -j ' + ctx.runListFile;
      var runs = 0;
      var success = false;

      var runList = ctx.mappedParameters.cookbook_attribute; //TODO JSON.parse ???
      runList = unflatten(runList, { delimiter: '/' });
      runList.run_list = ctx.unmappedParameters.run_list;

      ctx.access.writeFile({ path: ctx.runListFile, content: JSON.stringify(runList) }, function(err) {
        async.whilst(function() {
          return !success && runs < ctx.invokerConfig.max_runs;
        }, function(callback) {
          runs++;

          ctx.access.exec({ command: runCommand }, ctx.accessExecCallback(function(err) {
            if ((err && runs < ctx.invokerConfig.max_runs) || runs < ctx.invokerConfig.min_runs) {
              return callback();
            } else if (err) {
              return callback(err);
            } else {
              success = true;

              // Write outputs
              async.series([
                function(callback) {
                  ctx.access.exec({ command: 'ps aux' }, function(err, stdout, stderr) {
                    if (stdout) ctx.resultsStream.write({ name: 'ps', chunk: stdout, complete: true });

                    callback(err);
                  });
                },
                function(callback) {
                  ctx.resultsStream.write({ name: 'run_list', chunk: runList, complete: true });

                  ctx.resultsStream.write({ name: 'num_of_runs', chunk: runs, complete: true });

                  callback();
                }
              ], callback);
            }
          }));
        }, callback);
      });
    };

    ctx.invokerConfig.min_runs = ctx.invokerConfig.min_runs || 1;
    ctx.invokerConfig.max_runs = ctx.invokerConfig.max_runs || 3;

    //var baseDir = path.join('/', 'tmp', 'any2api-invoker-chef', instanceParams.executable_name);

    ctx.execDir = path.join(ctx.instancePath, 'executable');

    ctx.chefDir = path.join(ctx.instancePath, 'chef_data');
    ctx.cookbooksDir = path.join(ctx.instancePath, 'chef_data', 'cookbooks');
    ctx.rolesDir = path.join(ctx.instancePath, 'chef_data', 'roles');

    ctx.instanceStatusFile = path.join(ctx.instancePath, '.environment_installed');
    ctx.chefConfigFile = path.join(ctx.instancePath, 'chef.rb');
    ctx.runListFile = path.join(ctx.instancePath, 'run_list.json');

    async.series([
      async.apply(prepare),
      function(callback) {
        ctx.access.exists({ path: ctx.instanceStatusFile }, function(err, exists) {
          if (err) callback(err);
          else if (!exists) install(callback);
          else callback();
        });
      },
      async.apply(run)
    ], function(err) {
      async.series([
        //async.apply(ctx.access.remove, { path: baseDir }),
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
        if (err2) console.error(err2);

        callback(err);
      });
    });
  }
});
