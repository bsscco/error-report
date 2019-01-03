console.log(new Date().toTimeString());

const fs = require('fs');
const config = JSON.parse(fs.readFileSync(__dirname + '/config.json'));
const JIRA_SERVER_DOMAIN = config.jira_server_domain;
const APP_ACCESS_TOKEN = config.app_access_token;
const SLACK_DOMAIN = config.slack_domain;
const JIRA_USER_NAME = config.jira_username;
const JIRA_PWD = config.jira_pwd;
const DEVELOPER_LIST = config.developer_list;
const CHANNEL_LIST = config.channel_list;
const PLATFORM_LIST = config.platform_list;

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

    openSlackDlg(req.body.trigger_id, makeReportDlgPayload())
        .then(res => console.log(res.data))
        .catch(err => console.log(err.toString()));
});

app.post('/interact', (req, res) => {
    console.log(req.body);
    res.send('');

    const body = JSON.parse(req.body.payload);
    if (body.callback_id === 'save_report') {
        const saveData = {};
        saveData.input = body.submission;
        saveData.platform = getPlatform(saveData.input.assignee);
        if (saveData.input.environment === 'tttt') {
            saveData.input.channel = 'CASU375FD';
        }
        let setCookie = '';
        let slackUsers = [];
        loginJira()
            .then(res => {
                console.log('login');
                setCookie = res.headers['set-cookie'].join(';');
                return getSlackUsers();
            })
            .then(res => {
                console.log('getSlackUsers');
                slackUsers = res;
                return getJiraUsers(setCookie);
            })
            .then(res => {
                console.log('getJiraUsers');
                slackUsers.filter(slackUser => {
                    res.data.values.filter(jiraUser => {
                        if (jiraUser.displayName === saveData.input.assignee && slackUser.profile.display_name === saveData.input.assignee) {
                            saveData.assigneeSlackUser = slackUser;
                            saveData.assigneeJiraUser = jiraUser;
                        }
                    });
                    if (slackUser.id === body.user.id) {
                        saveData.reporterSlackUser = slackUser;
                    }
                });

                return createJiraIssue(setCookie, makeJiraReportIssuePayload(saveData));
            })
            .then(res => {
                console.log('createJiraIssue');
                saveData.jiraReport.issueKey = res.data.key;

                return doJiraIssueTransition(setCookie, saveData.jiraReport.issueKey, makeJiraReportTransitionReadyPayload(saveData.platform));
            })
            .then(res => {
                console.log('doJiraIssueTransition');
                return sendSlackMsg('', makeReportSavedMsgPayload(saveData, true));
            })
            .then(res => {
                console.log('sendSlackMsg');
                saveData.slackMsg = {};
                saveData.slackMsg.ts = res.data.ts;

                return sendSlackMsg(body.response_url, makeReportSavedMsgPayload(saveData, false));
            })
            .then(res => editJiraIssue(setCookie, saveData.jiraReport.issueKey, makeJiraReportSlackLinkAdditionPayload(saveData)))
            .then(res => console.log(res.data))
            .catch(err => console.log(err.toString()));
    }
});

function getPlatform(assignee) {
    let developer;
    for (const idx in DEVELOPER_LIST) {
        const d = DEVELOPER_LIST[idx];
        if (d.value === assignee) {
            developer = d;
            break;
        }
    }
    for (const idx in PLATFORM_LIST) {
        const p = PLATFORM_LIST[idx];
        if (p.platform === developer.platform) {
            return p;
        }
    }
    return PLATFORM_LIST[3];
}

// slack
function getSlackUsers() {
    return axios
        .get('https://slack.com/api/users.list', {
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + APP_ACCESS_TOKEN
            }
        })
        .then(res => {
            const liveMembers = res.data.members.filter(member => {
                if (member.deleted || member.is_bot || member.id === 'USLACKBOT' || member.is_restricted) {
                    return false;
                }
                return true;
            });
            return new Promise(resolve => resolve(liveMembers));
        })
}

function openSlackDlg(triggerId, payload) {
    return axios.post('https://slack.com/api/dialog.open', JSON.stringify({
        trigger_id: triggerId,
        dialog: JSON.stringify(payload)
    }), {
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + APP_ACCESS_TOKEN}
    });
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
        title: '버그리포팅(스크린샷은 댓글로 달아주세요.)',
        submit_label: '등록',
        elements: [
            {
                type: 'textarea',
                label: '현상',
                name: 'situation',
                placeholder: '필터를 누르면 강제종료 됩니다.',
                value: null,
                optional: false,
                hint: '스크린샷은 스레드에 댓글로 달아주세요.',
            },
            {
                type: 'textarea',
                label: '발생경로 & 재현가능여부',
                name: 'path',
                placeholder: '메인>스토어>자취가구피드>필터 영역\n재현가능: O',
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
                type: 'select',
                label: '예상 담당자',
                name: 'assignee',
                placeholder: null,
                value: null,
                optional: false,
                options: DEVELOPER_LIST
            },
            {
                type: 'select',
                label: '리포팅 채널',
                name: 'channel',
                placeholder: null,
                value: null,
                optional: false,
                options: CHANNEL_LIST
            },
        ]
    };
    return json;
}

function makeReportSavedMsgPayload(saveData, forChannelMsg) {
    const fields = [];
    fields.push({
        title: '보고자',
        value: '<@' + saveData.reporterSlackUser.id + '>',
        short: false
    });
    fields.push({
        title: '담당자',
        value: '<@' + saveData.assigneeSlackUser.id + '>',
        short: false
    });
    fields.push({
        title: '현상',
        value: saveData.input.situation,
        short: false
    });
    fields.push({
        title: '발생경로 & 재현가능여부',
        value: saveData.input.path,
        short: false
    });
    fields.push({
        title: '사용환경',
        value: saveData.input.environment,
        short: false
    });
    fields.push({
        title: '지라링크',
        value: JIRA_SERVER_DOMAIN + '/browse/' + saveData.jiraReport.issueKey,
        short: false
    });
    const json = {
        text: '<@' + config.qa_manager + '>',
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
    if (forChannelMsg) {
        json.channel = saveData.input.channel;
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

function getJiraUsers(setCookie) {
    return axios.get(JIRA_SERVER_DOMAIN + '/rest/api/2/group/member?groupname=jira-software-users',
        {
            headers: {
                'Cookie': setCookie,
                'Content-Type': 'application/json'
            }
        }
    );
}

function createJiraIssue(setCookie, data) {
    return axios.post(JIRA_SERVER_DOMAIN + '/rest/api/2/issue', JSON.stringify(data), {
        headers: {
            'Cookie': setCookie,
            'Content-Type': 'application/json'
        }
    });
}

function doJiraIssueTransition(setCookie, issueKey, data) {
    return axios.post(JIRA_SERVER_DOMAIN + '/rest/api/2/issue/' + issueKey + '/transitions', JSON.stringify(data), {
        headers: {
            'Cookie': setCookie,
            'Content-Type': 'application/json'
        }
    });
}

function editJiraIssue(setCookie, issueKey, data) {
    return axios.put(JIRA_SERVER_DOMAIN + '/rest/api/2/issue/' + issueKey, JSON.stringify(data), {
        headers: {
            'Cookie': setCookie,
            'Content-Type': 'application/json'
        }
    });
}

function makeJiraReportIssuePayload(saveData) {
    saveData.jiraReport = {};
    saveData.jiraReport.description = '';
    saveData.jiraReport.description += '\nh2. 보고자 \n\n' + saveData.reporterSlackUser.profile.display_name;
    saveData.jiraReport.description += '\nh2. 현상 \n\n' + saveData.input.situation;
    saveData.jiraReport.description += '\nh2. 발생경로 & 재현가능여부\n\n' + saveData.input.path;
    saveData.jiraReport.description += '\nh2. 사용환경 \n\n' + saveData.input.environment;

    const json = {
        "fields": {
            "project": {"id": "10400"/*OK-KANBAN*/},
            "issuetype": {"id": "10103" /*BugType*/},
            "summary": '[' + saveData.platform.platform + '] ' + saveData.input.situation.replace(/\n/g, ' ').substr(0, 100),
            "assignee": {"name": saveData.assigneeJiraUser.name},
            "reporter": {"name": "slack_bug"},
            "priority": {"id": "1" /*HIGHEST*/},
            "description": saveData.jiraReport.description,
            "components": [saveData.platform.component],
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

function makeJiraReportSlackLinkAdditionPayload(saveData) {
    saveData.jiraReport.description += '\nh2. 슬랙링크 \n\n' + SLACK_DOMAIN + '/archives/' + saveData.input.channel + '/p' + saveData.slackMsg.ts.replace('.', '');
    const json = {
        "fields": {
            "description": saveData.jiraReport.description,
        }
    };
    return json;
}


// Start the server
const PORT = process.env.PORT || 10000;
// const PORT = process.env.PORT || 55000;
app.listen(PORT, () => {
    console.log(`App listening on port ${PORT}`);
    console.log('Press Ctrl+C to quit.');
});

// 테스트 코드
// const input = {
//     situation: 'situationsituationsituationsituationsituationsituationsituationsituationsituationsituationsituationsituationsituationsituationsituation',
//     path: 'path',
//     environment: 'tttt',
//     assignee: '비스코',
//     channel: 'CASU375FD',
// }
// let saveData = {};
// saveData.input = input;
// saveData.platform = getPlatform(saveData.input.assignee);
// saveData.reporterSlackUser = {profile: {display_name: '비스코'}};
// let setCookie = '';
// let slackUsers;
// let jiraUsers;
// let slackJiraUsers;
//
// loginJira()
//     .then(res => {
//         setCookie = res.headers['set-cookie'].join(';');
//         return getSlackUsers();
//     })
//     .then(res => {
//         slackUsers = res;
//         return getJiraUsers(setCookie);
//     })
//     .then(res => {
//         jiraUsers = res.data.values;
//
//         slackJiraUsers = jiraUsers.filter(jiraUser => {
//             slackUsers.filter(slackUser => {
//                 if (jiraUser.displayName === saveData.input.assignee && saveData.input.assignee === slackUser.profile.display_name) {
//                     saveData.assigneeSlackUser = slackUser;
//                     saveData.assigneeJiraUser = jiraUser;
//                 }
//             });
//         });
//
//         return createJiraIssue(setCookie, makeJiraReportIssuePayload(saveData));
//     })
//     .then(res => {
//         saveData.jiraReport.issueKey = res.data.key;
//         return doJiraIssueTransition(setCookie, saveData.jiraReport.issueKey, makeJiraReportTransitionReadyPayload(saveData.platform));
//     })
    // .then(res => sendSlackMsg(makeReportSavedMsgPayload(saveData))
// .then(res => sendSlackMsg(body.response_url, makeReportSavedMsgPayload(input)))
//     .then(res => editJiraIssues(platforms))
//     .then(res => console.log(res.data))
//     .catch(err => console.log(JSON.stringify(err.response.data)));