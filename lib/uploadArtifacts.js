'use strict';

/* eslint-disable no-use-before-define */

const fs = require('fs');
const BbPromise = require('bluebird');
const filesize = require('filesize');
const path = require('path');

module.exports = {
    uploadCloudFormationFile(fileName, cf) {

        const compiledTemplateFileName = fileName || 'compiled-cloudformation-template.json';
        this.serverless.cli.log('Uploading CloudFormation file to S3...' + compiledTemplateFileName);

        const body = JSON.stringify(cf || this.serverless.service.provider.compiledCloudFormationTemplate);
        let params = {
            Bucket: this.bucketName,
            Key: `${this.serverless.service.package.artifactDirectoryName}/${compiledTemplateFileName}`,
            Body: body,
            ContentType: 'application/json',
        };

        const deploymentBucketObject = this.serverless.service.provider.deploymentBucketObject;
        if (deploymentBucketObject) {
            params = setServersideEncryptionOptions(params, deploymentBucketObject);
        }
        fs.writeFile(this.packagePath+'/'+compiledTemplateFileName,body, () => { });
        return this.provider.request('S3',
            'putObject',
            params,
            this.options.stage,
            this.options.region);
    },

    uploadZipFile(artifactFilePath) {
        const fileName = artifactFilePath.split(path.sep).pop();

        let params = {
            Bucket: this.bucketName,
            Key: `${this.serverless.service.package.artifactDirectoryName}/${fileName}`,
            Body: fs.createReadStream(artifactFilePath),
            ContentType: 'application/zip',
        };

        const deploymentBucketObject = this.serverless.service.provider.deploymentBucketObject;
        if (deploymentBucketObject) {
            params = setServersideEncryptionOptions(params, deploymentBucketObject);
        }

        return this.provider.request('S3',
            'putObject',
            params,
            this.options.stage,
            this.options.region);
    },

    uploadFunctions() {
        let shouldUploadService = false;
        this.serverless.cli.log('Uploading artifacts...');
        const functionNames = this.serverless.service.getAllFunctions();
        const uploadPromises = functionNames.map(name => {
            const functionArtifactFileName = this.provider.naming.getFunctionArtifactName(name);
            const functionObject = this.serverless.service.getFunction(name);
            functionObject.package = functionObject.package || {};
            let artifactFilePath = functionObject.package.artifact ||
                this.serverless.service.package.artifact;
            if (!artifactFilePath ||
                (this.serverless.service.artifact && !functionObject.package.artifact)) {
                if (this.serverless.service.package.individually || functionObject.package.individually) {
                    const artifactFileName = functionArtifactFileName;
                    artifactFilePath = path.join(this.packagePath, artifactFileName);
                    return this.uploadZipFile(artifactFilePath);
                }
                shouldUploadService = true;
                return BbPromise.resolve();
            }
            return this.uploadZipFile(artifactFilePath);
        });

        return BbPromise.all(uploadPromises).then(() => {
            if (shouldUploadService) {
                const artifactFileName = this.provider.naming.getServiceArtifactName();
                const artifactFilePath = path.join(this.packagePath, artifactFileName);
                const stats = fs.statSync(artifactFilePath);
                this.serverless.cli.log(`Uploading service .zip file to S3 (${filesize(stats.size)})...`);
                return this.uploadZipFile(artifactFilePath);
            }
            return BbPromise.resolve();
        });
    },

    uploadArtifacts() {
        return BbPromise.bind(this)
            .then(this.uploadCloudFormationFile)
            .then(this.uploadFunctions);
    },
};

function setServersideEncryptionOptions(putParams, deploymentBucketOptions) {
    const encryptionFields = [
        ['serverSideEncryption', 'ServerSideEncryption'],
        ['sseCustomerAlgorithim', 'SSECustomerAlgorithm'],
        ['sseCustomerKey', 'SSECustomerKey'],
        ['sseCustomerKeyMD5', 'SSECustomerKeyMD5'],
        ['sseKMSKeyId', 'SSEKMSKeyId'],
    ];

    const params = putParams;

    encryptionFields.forEach((element) => {
        if (deploymentBucketOptions[element[0]]) {
            params[element[1]] = deploymentBucketOptions[element[0]];
        }
    }, this);

    return params;
}
