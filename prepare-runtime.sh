#!/bin/bash

set -e

#SCRIPT_DIR=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
SCRIPT_DIR=`dirname $0`

sys_has() {
  type "$1" > /dev/null 2>&1
  return $?
}



if ! sys_has "ssh"; then
  if sys_has "apt-get"; then
    sudo apt-get -y update
    sudo apt-get -y install openssh-client
  elif sys_has "yum"; then
    sudo yum -y install openssh-clients
  else
    echo "FAIL: OpenSSH client must be installed"
    exit 1
  fi
fi



cd $SCRIPT_DIR

npm install
