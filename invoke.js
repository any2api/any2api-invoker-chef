var pkg = require('./package.json');

var debug = require('debug')(pkg.name);
var path = require('path');
var fs = require('fs-extra');
var async = require('async');
var unflatten = require('flat').unflatten;
var _ = require('lodash');
var uuid = require('uuid');

var util = require('any2api-util');



util.readInput(null, function(err, spec, params) {
  if (err) throw err;

  if (!params.run_list) {
    console.error('run_list parameter missing');

    process.exit(1);
  }

  var config = params.invoker_config || {};

  config.access = config.access || 'local';
  config.min_runs = config.min_runs || 1;
  config.max_runs = config.max_runs || 3;
  config.dir = config.dir || '/tmp/any2api-invoker-chef';
  
  var access;

  if (config.access === 'local') {
    access = require('any2api-access').Local(config);
  } else if (config.access === 'ssh') {
    access = require('any2api-access').SSH(config);
  } else {
    console.error('access \'' + config.access + '\' not supported');

    process.exit(1);
  }

  var chefDir = path.join(config.dir, 'chef_data');
  var cookbooksDir = path.join(config.dir, 'chef_data', 'cookbooks');
  var rolesDir = path.join(config.dir, 'chef_data', 'roles');

  var stateFile = path.join(config.dir, '.environment_installed');
  var chefConfigFile = path.join(config.dir, 'chef.rb');
  var runListFile = path.join(config.dir, 'run_list.json');

  var chefConfig = [
    'file_cache_path "' + chefDir + '"',
    'cookbook_path [ "' + cookbooksDir + '" ]',
    'role_path "' + rolesDir + '"'
  ].join('\n');

  var commands = {
    install: [
      'sudo apt-get -y update',
      'sudo apt-get -y install curl',
      'sudo yum -y install curl',
      'curl -L https://www.opscode.com/chef/install.sh | sudo bash'
    ].join(' ; '),
    run: 'sudo chef-solo -c ' + chefConfigFile + ' -j ' + runListFile,
  };



  var install = function(done) {
    var cookbookName = spec.executable.cookbook_name;
    var cookbookDir = path.join(cookbooksDir, cookbookName);

    async.series([
      async.apply(access.writeFile, { path: chefConfigFile, content: chefConfig }),
      async.apply(access.mkdir, { path: path.join(spec.executable.path, spec.executable.dependencies_subdir) }),
      async.apply(access.copy, { sourcePath: path.join(spec.executable.path, spec.executable.dependencies_subdir), targetPath: cookbooksDir }),
      function(callback) {
        access.mkdir({ path: cookbookDir }, callback);
      },
      function(callback) {
        access.copy({ sourcePath: spec.executable.path, targetPath: cookbookDir }, callback);
      },
      function(callback) {
        access.remove({ path: path.join(cookbookDir, spec.executable.dependencies_subdir) }, callback);
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

          callback();
        });
      },
      async.apply(access.writeFile, { path: stateFile, content: 'installed' })
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
              async.apply(fs.mkdirs, path.join('out')),
              async.apply(fs.writeFile, path.join('out', 'run_list.json'), JSON.stringify(attributes)),
              function(callback) {
                access.exec({ command: 'ps aux' }, function(err, stdout, stderr) {
                  psOutput = stdout;

                  callback(err);
                });
              },
              function(callback) {
                fs.writeFile(path.join('out', 'ps_aux.txt'), psOutput, callback);
              }
            ], done);
          }
        });
      }, done);
    });
  };

  access.exists({ path: stateFile }, function(err, exists) {
    if (err) throw err;

    if (!exists) {
      async.series([
        async.apply(util.placeExecutable, { spec: spec, access: access, dir: path.join(config.dir, 'exec') }),
        async.apply(access.mkdir, { path: chefDir }),
        async.apply(access.mkdir, { path: cookbooksDir }),
        async.apply(access.mkdir, { path: rolesDir }),
        async.apply(install),
        async.apply(run)
      ],
      function(err) {
        access.terminate();

        if (err) throw err;
      });
    } else {
      run(function(err) {
        access.terminate();

        if (err) throw err;
      });
    }
  });
});
