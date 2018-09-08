console.log(new Date().toTimeString());

const fs = require('fs');
const config = JSON.parse(fs.readFileSync('config.json'));
const JIRA_SERVER_DOMAIN = config.jira_server_domain;
const APP_ACCESS_TOKEN = config.app_access_token;
const SLACK_DOMAIN = config.slack_domain;
const SLACK_APP_CHANNEL_ID = config.slack_app_channel_id;
const SLACK_WEB_CHANNEL_ID = config.slack_web_channel_id;
const SLACK_TEST_CHANNEL_ID = config.slack_test_channel_id;
const JIRA_ANDROID_DEVELOPER_USERNAME = config.jira_android_developer_username;
const JIRA_IOS_DEVELOPER_USERNAME = config.jira_ios_developer_username;
const JIRA_WEB_DEVELOPER_USERNAME = config.jira_web_developer_username;
const JIRA_USER_NAME = config.jira_username;
const JIRA_PWD = config.jira_pwd;

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());

app.get('/', (req, res) => {
    res.status(200).send('Hello, Bugs!!').end();
});

app.post('/command', (req, res) => {
    console.log(req.body);
    res.send('');

    openSlackDlg(req.body.trigger_id, makeReportDlgPayload(res.data))
        .then(res => console.log(res.data))
        .catch(err => console.log(err.toString()));
});

app.post('/interact', (req, res) => {
    console.log(req.body);
    res.send('');

    const body = JSON.parse(req.body.payload);
    if (body.callback_id === 'save_report') {
        const input = body.submission;
        let setCookie = '';
        const platforms = getPlatforms(input.environment);
        loginJira()
            .then(res => {
                setCookie = res.headers['set-cookie'].join(';');
                return createJiraIssues(input, platforms);
            })
            .then(res => doJiraIssueTransitions(platforms))
            .then(res => sendSlackMsgsReportSaved(input, platforms))
            .then(res => sendSlackMsg(body.response_url, makeReportSavedMsgPayload(input)))
            .then(res => editJiraIssues(platforms))
            .then(res => console.log(res.data))
            .catch(err => console.log(err.toString()));
    }
});

function getPlatforms(environment) {
    const platforms = [];
    if (/모두|모든|아이|ios/g.test(environment.toLowerCase())) {
        platforms.push({
            platform: 'iOS',
            component: {id: "10601"},
            assignee: JIRA_IOS_DEVELOPER_USERNAME,
            transition: '61',
            slackChannelId: SLACK_APP_CHANNEL_ID
        });
    }
    if (/모두|모든|안드|and/g.test(environment.toLowerCase())) {
        platforms.push({
            platform: 'Android',
            component: {id: "10602"},
            assignee: JIRA_ANDROID_DEVELOPER_USERNAME,
            transition: '61',
            slackChannelId: SLACK_APP_CHANNEL_ID
        });
    }
    if (/모두|모든|웹|브라|web/g.test(environment.toLowerCase())) {
        platforms.push({
            platform: 'Web',
            component: {id: "10603"},
            assignee: JIRA_WEB_DEVELOPER_USERNAME,
            transition: '61',
            slackChannelId: SLACK_WEB_CHANNEL_ID
        });
    }
    // if (/백|back|서버|server/g.test(environment.toLowerCase())) {
    //     platforms.push({platform: 'Server', component: {id: "10606"}, assignee: 'jinsik', transition: '331'});
    // }
    return platforms;
}

// slack
function openSlackDlg(triggerId, payload) {
    return axios.post('https://slack.com/api/dialog.open', JSON.stringify({
        trigger_id: triggerId,
        dialog: JSON.stringify(payload)
    }), {
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + APP_ACCESS_TOKEN}
    });
}

function sendSlackMsgsReportSaved(input, platforms) {
    return platforms.reduce((promiseChain, platform) => {
        return promiseChain.then((chainResults) => {
            return sendSlackMsg('', makeReportSavedMsgPayload(input, platform))
                .then(res => {
                    platform.ts = res.data.ts;
                    chainResults.push(res);
                    return new Promise(resolve => resolve(chainResults));
                });
        });
    }, Promise.resolve([]));
}

function sendSlackMsg(responseUrl, payload) {
    return axios.post(responseUrl ? responseUrl : 'https://slack.com/api/chat.postMessage', JSON.stringify(payload), {
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + APP_ACCESS_TOKEN
        }
    });
}

function makeReportDlgPayload() {
    json = {
        callback_id: 'save_report',
        title: '버그리포팅 하기',
        submit_label: '등록',
        elements: [
            {
                type: 'textarea',
                label: '현상',
                name: 'situation',
                placeholder: '필터를 누르면 강제종료 됩니다.',
                value: null,
                optional: false
            },
            {
                type: 'textarea',
                label: '발생 경로',
                name: 'path',
                placeholder: '메인>스토어>자취가구피드>필터 영역',
                value: null,
                optional: false
            },
            {
                type: 'text',
                label: '사용환경',
                name: 'environment',
                placeholder: 'iOS 11.4.1 / 앱버전 v6.1.77',
                value: null,
                optional: false
            },
            {
                type: 'text',
                label: '재현가능여부',
                name: 'reappearance',
                placeholder: 'O',
                hint: '스크린샷은 스레드에 댓글로 달아주세요.',
                value: null,
                optional: false
            }
        ]
    };
    return json;
}

function makeReportSavedMsgPayload(input, platform) {
    const fields = [];
    fields.push({
        title: '현상',
        value: input.situation,
        short: false
    });
    fields.push({
        title: '발생 경로',
        value: input.path,
        short: false
    });
    fields.push({
        title: '사용환경',
        value: input.environment,
        short: false
    });
    fields.push({
        title: '재현가능여부',
        value: input.reappearance,
        short: false
    });

    // let jiraLinks = '';
    // platforms.map(platform => {
    //     jiraLinks += '\n' + ;
    // })
    if (platform) {
        fields.push({
            title: '지라링크',
            value: platform.platform + " : " + JIRA_SERVER_DOMAIN + '/browse/' + platform.issueKey,
            short: false
        });
    }
    const json = {
        attachments: [
            {
                title: '버그리포팅 등록 완료',
                color: '#35c5f0'
            },
            {
                fallback: 'none',
                callback_id: 'none',
                color: '#35c5f0',
                fields: fields
            }
        ]
    };
    if (platform) {
        json.as_user = false;
        json.channel = platform.slackChannelId;
    }
    return json;
}

// jira
function loginJira() {
    return axios.post(JIRA_SERVER_DOMAIN + '/rest/auth/1/session',
        JSON.stringify({
            username: JIRA_USER_NAME,
            password: JIRA_PWD
        }),
        {
            headers: {
                'Content-Type': 'application/json'
            }
        }
    );
}

function createJiraIssues(input, platforms) {
    return platforms.reduce((promiseChain, platform) => {
        return promiseChain.then((chainResults) => {
            return createJiraIssue(setCookie, makeJiraReportIssuePayload(input, platform))
                .then(res => {
                    platform.issueKey = res.data.key;
                    chainResults.push(res);
                    return new Promise(resolve => resolve(chainResults));
                });
        });
    }, Promise.resolve([]));
}

function createJiraIssue(setCookie, data) {
    return axios.post(JIRA_SERVER_DOMAIN + '/rest/api/2/issue', JSON.stringify(data), {
        headers: {
            'Cookie': setCookie,
            'Content-Type': 'application/json'
        }
    });
}

function doJiraIssueTransitions(platforms) {
    return platforms.reduce((promiseChain, platform) => {
        return promiseChain.then((chainResults) => {
            return doJiraIssueTransition(setCookie, platform.issueKey, makeJiraReportTransitionReadyPayload(platform))
                .then(res => {
                    chainResults.push(res);
                    return new Promise(resolve => resolve(chainResults));
                });
        });
    }, Promise.resolve([]));
}

function doJiraIssueTransition(setCookie, issueKey, data) {
    return axios.post(JIRA_SERVER_DOMAIN + '/rest/api/2/issue/' + issueKey + '/transitions', JSON.stringify(data), {
        headers: {
            'Cookie': setCookie,
            'Content-Type': 'application/json'
        }
    });
}

function editJiraIssues(platforms) {
    return platforms.reduce((promiseChain, platform) => {
        return promiseChain.then((chainResults) => {
            return editJiraIssue(setCookie, platform.issueKey, makeJiraReportSlackLinkAdditionPayload(platform))
                .then(res => {
                    chainResults.push(res);
                    return new Promise(resolve => resolve(chainResults));
                });
        });
    }, Promise.resolve([]));
}

function editJiraIssue(setCookie, issueKey, data) {
    return axios.put(JIRA_SERVER_DOMAIN + '/rest/api/2/issue/' + issueKey, JSON.stringify(data), {
        headers: {
            'Cookie': setCookie,
            'Content-Type': 'application/json'
        }
    });
}

function makeJiraReportIssuePayload(input, platform) {
    platform.description = '';
    platform.description += '\nh2. 현상 \n\n' + input.situation;
    platform.description += '\nh2. 발생 경로 \n\n' + input.path;
    platform.description += '\nh2. 사용환경 \n\n' + input.environment;
    platform.description += '\nh2. 재현가능여부 \n\n' + input.reappearance;

    const json = {
        "fields": {
            "project": {"id": "10400"/*OK-KANBAN*/},
            "issuetype": {"id": "10103" /*BugType*/},
            "summary": '[' + platform.platform + '] ' + input.situation,
            "assignee": {"name": platform.assignee},
            "reporter": {"name": "bsscco"},
            "priority": {"id": "1" /*HIGHEST*/},
            "description": platform.description,
            "components": [platform.component],
        }
    };
    return json;
}

function makeJiraReportTransitionReadyPayload(platform) {
    const json = {
        "transition": platform.transition + ""
    };
    return json;
}

function makeJiraReportSlackLinkAdditionPayload(platform) {
    platform.description += '\nh2. 슬랙링크 \n\n' + SLACK_DOMAIN + '/archives/' + platform.slackChannelId + '/p' + platform.ts.replace('.', '');
    const json = {
        "fields": {
            "description": platform.description
        }
    };
    return json;
}


// Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`App listening on port ${PORT}`);
    console.log('Press Ctrl+C to quit.');
});

// 테스트 코드
const input = {
    situation: 'situation',
    path: 'path',
    environment: 'and ios',
    reappearance: 'reappearance',
}
let setCookie = '';
const platforms = getPlatforms(input.environment);
loginJira()
    .then(res => {
        setCookie = res.headers['set-cookie'].join(';');
        return createJiraIssues(input, platforms);
    })
    .then(res => doJiraIssueTransitions(platforms))
    .then(res => sendSlackMsgsReportSaved(input, platforms))
    // .then(res => sendSlackMsg(body.response_url, makeReportSavedMsgPayload(input)))
    .then(res => editJiraIssues(platforms))
    .then(res => console.log(res.data))
    .catch(err => console.log(err.toString()));