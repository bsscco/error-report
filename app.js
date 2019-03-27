console.log(new Date().toTimeString());

const fs = require('fs');
const config = JSON.parse(fs.readFileSync(__dirname + '/config.json'));

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());

app.get('/', (req, res) => {
    res.status(200).send('Hello, Error Report!!').end();
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
        const saveData = {trackSlackUsers: []};
        saveData.input = body.submission;
        saveData.platform = getPlatform(saveData.input.assignee);
        if (saveData.input.environment === 'tttt') {
            saveData.input.channel = 'CASU375FD';
        }
        let setCookie = '';
        let slackUsers = [];
        console.log('login');
        loginJira()
            .then(res => {
                console.log('logined');
                setCookie = res.headers['set-cookie'].join(';');
                return getSlackUsers();
            })
            .then(res => {
                console.log('gotSlackUsers');
                slackUsers = res;
                return getUserGroups();
            })
            .then(res => {
                console.log('gotUsergroups ' + res.data.usergroups.length);
                for (const idx in res.data.usergroups) {
                    const userGroup = res.data.usergroups[idx];
                    if (userGroup.handle === config.track_list[saveData.input.track].user_group_handle) {
                        saveData.trackSlackUserGroup = userGroup;
                        break;
                    }
                }
                return getJiraUsers(setCookie);
            })
            .then(res => {
                console.log('gotJiraUsers');
                const track = config.track_list[saveData.input.track];
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
                    if (track.users && track.users.includes(slackUser.profile.display_name)) {
                        saveData.trackSlackUsers.push(slackUser);
                    }
                });

                return createJiraIssue(setCookie, makeJiraReportIssuePayload(saveData));
            })
            .then(res => {
                console.log('createdJiraIssue');
                saveData.jiraReport.issueKey = res.data.key;

                return doJiraIssueTransition(setCookie, saveData.jiraReport.issueKey, makeJiraReportTransitionReadyPayload(saveData.platform));
            })
            .then(res => {
                console.log('didJiraIssueTransition');
                return sendSlackMsg('', makeReportSavedMsgPayload(saveData, true));
            })
            .then(res => {
                console.log('sentSlackMsg');
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
    for (const idx in config.developer_list) {
        const d = config.developer_list[idx];
        if (d.value === assignee) {
            developer = d;
            break;
        }
    }
    for (const idx in config.platform_list) {
        const p = config.platform_list[idx];
        if (p.platform === developer.platform) {
            return p;
        }
    }
    return config.platform_list[3];
}

// slack
function getSlackUsers() {
    return axios
        .get('https://slack.com/api/users.list', {
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + config.app_access_token
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

function getUserGroups() {
    return axios
        .get('https://slack.com/api/usergroups.list', {
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + config.app_access_token
            }
        });
}

function openSlackDlg(triggerId, payload) {
    return axios.post('https://slack.com/api/dialog.open', JSON.stringify({
        trigger_id: triggerId,
        dialog: JSON.stringify(payload)
    }), {
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + config.app_access_token}
    });
}

function sendSlackMsg(responseUrl, payload) {
    return axios.post(responseUrl ? responseUrl : 'https://slack.com/api/chat.postMessage', JSON.stringify(payload), {
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + config.app_access_token
        }
    });
}

function makeReportDlgPayload() {
    const json = {
        callback_id: 'save_report',
        title: '오류리포팅(스크린샷은 댓글로)',
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
                label: '사용환경 & 발생경로 & 재현가능여부',
                name: 'environment',
                value: '(필수정보 3종류)\n- 사용환경 : \n- 발생경로 : \n- 재현가능여부 : O',
                hint: '예) 사용환경 : Android파이 / 앱 v6.1.3 - 발생경로 : 메인>스토어홈>필터 영역',
                optional: false
            },
            {
                type: 'select',
                label: '예상 담당트랙',
                name: 'track',
                placeholder: null,
                value: null,
                optional: false,
                options: config.track_list
            },
            {
                type: 'select',
                label: '예상 담당개발자',
                name: 'assignee',
                placeholder: null,
                value: null,
                optional: false,
                options: config.developer_list
            },
            {
                type: 'select',
                label: '리포팅 채널',
                name: 'channel',
                placeholder: null,
                value: null,
                optional: false,
                options: config.channel_list
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
        title: '현상',
        value: saveData.input.situation,
        short: false
    });
    fields.push({
        title: '사용환경 & 발생경로 & 재현가능여부',
        value: saveData.input.environment,
        short: false
    });
    fields.push({
        title: '예상 담당트랙',
        value: config.track_list[saveData.input.track].label + '\n<!subteam^' + saveData.trackSlackUserGroup.id + '|' + saveData.trackSlackUserGroup.handle + '>',
        short: false
    });
    if (saveData.trackSlackUsers) {
        for (const idx in saveData.trackSlackUsers) {
            fields[fields.length - 1].value += ' <@' + saveData.trackSlackUsers[idx].id + '>';
        }
    }
    fields.push({
        title: '예상 담당개발자',
        value: '<@' + saveData.assigneeSlackUser.id + '>',
        short: false
    });
    fields.push({
        title: '지라링크',
        value: config.jira_server_domain + '/browse/' + saveData.jiraReport.issueKey,
        short: false
    });
    const json = {
        text: '',
        attachments: [
            {
                title: '오류리포팅 등록 완료',
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
    for (const idx in config.qa_managers) {
        json.text += '<@' + config.qa_managers[idx] + '> ';
    }
    if (forChannelMsg) {
        json.channel = saveData.input.channel;
    }
    return json;
}

// jira
function loginJira() {
    return axios.post(config.jira_server_domain + '/rest/auth/1/session',
        JSON.stringify({
            username: config.jira_username,
            password: config.jira_pwd
        }),
        {
            headers: {
                'Content-Type': 'application/json'
            }
        }
    );
}

function getJiraUsers(setCookie) {
    return axios.get(config.jira_server_domain + '/rest/api/2/group/member?groupname=jira-software-users',
        {
            headers: {
                'Cookie': setCookie,
                'Content-Type': 'application/json'
            }
        }
    );
}

function createJiraIssue(setCookie, data) {
    return axios.post(config.jira_server_domain + '/rest/api/2/issue', JSON.stringify(data), {
        headers: {
            'Cookie': setCookie,
            'Content-Type': 'application/json'
        }
    });
}

function doJiraIssueTransition(setCookie, issueKey, data) {
    return axios.post(config.jira_server_domain + '/rest/api/2/issue/' + issueKey + '/transitions', JSON.stringify(data), {
        headers: {
            'Cookie': setCookie,
            'Content-Type': 'application/json'
        }
    });
}

function editJiraIssue(setCookie, issueKey, data) {
    return axios.put(config.jira_server_domain + '/rest/api/2/issue/' + issueKey, JSON.stringify(data), {
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
    saveData.jiraReport.description += '\nh2. 사용환경 & 발생경로 & 재현가능여부\n\n' + saveData.input.environment;
    saveData.jiraReport.description += '\n\nh2. 예상 담당트랙 \n\n' + config.track_list[saveData.input.track].label;
    saveData.jiraReport.description += '\nh2. 예상 담당자 \n\n' + saveData.input.assignee;

    const json = {
        "fields": {
            "project": {"id": "10400"/*OK-KANBAN*/},
            "issuetype": {"id": "10103" /*BugType*/},
            "summary": '[' + saveData.platform.platform + '] ' + convertUtf8mb4(saveData.input.situation).replace(/\n/g, ' ').substr(0, 100),
            "assignee": {"name": saveData.assigneeJiraUser.name},
            "reporter": {"name": "slack_bug"},
            "priority": {"id": "1" /*HIGHEST*/},
            "description": convertUtf8mb4(saveData.jiraReport.description),
            "components": [saveData.platform.component],
        }
    };
    if (config.track_list[saveData.input.track].jira_label) {
        json.fields.labels = [config.track_list[saveData.input.track].jira_label];
    }
    return json;
}

function makeJiraReportTransitionReadyPayload(platform) {
    const json = {
        "transition": platform.transition + ""
    };
    return json;
}

function makeJiraReportSlackLinkAdditionPayload(saveData) {
    saveData.jiraReport.description += '\nh2. 슬랙링크 \n\n' + config.slack_domain + '/archives/' + saveData.input.channel + '/p' + saveData.slackMsg.ts.replace('.', '');
    const json = {
        "fields": {
            "description": saveData.jiraReport.description,
        }
    };
    return json;
}

function convertUtf8mb4(str) {
    const rx = new RegExp('[\uD800-\uDBFF][\uDC00-\uDFFF]');
    return str.replace(rx, "??");
}

// Start the server
const PORT = process.env.PORT || 10000;
// const PORT = process.env.PORT || 55000;
app.listen(PORT, () => {
    console.log(`App listening on port ${PORT}`);
    console.log('Press Ctrl+C to quit.');
});

// 테스트 코드
const input = {
    situation: 'situationsituatio😭situationsituatio',
    path: 'path',
    environment: 'tttt',
    track: '4',
    assignee: '비스코',
    channel: 'CASU375FD',
}
const saveData = {trackSlackUsers: []};
saveData.input = input;
saveData.platform = getPlatform(saveData.input.assignee);
saveData.reporterSlackUser = {profile: {display_name: '비스코'}};
let setCookie = '';
let slackUsers;
let jiraUsers;

loginJira()
    .then(res => {
        console.log('logined');
        setCookie = res.headers['set-cookie'].join(';');
        return getSlackUsers();
    })
    .then(res => {
        console.log('gotSlackUsers');
        slackUsers = res;
        return getUserGroups();
    })
    .then(res => {
        console.log('gotUsergroups ' + res.data.usergroups.length);
        for (const idx in res.data.usergroups) {
            const userGroup = res.data.usergroups[idx];
            if (userGroup.handle === config.track_list[saveData.input.track].user_group_handle) {
                saveData.trackSlackUserGroup = userGroup;
                break;
            }
        }
        return getJiraUsers(setCookie);
    })
    .then(res => {
        console.log('gotJiraUsers');
        const track = config.track_list[saveData.input.track];
        slackUsers.filter(slackUser => {
            res.data.values.filter(jiraUser => {
                if (jiraUser.displayName === saveData.input.assignee && slackUser.profile.display_name === saveData.input.assignee) {
                    saveData.assigneeSlackUser = slackUser;
                    saveData.assigneeJiraUser = jiraUser;
                }
            });
            // if (slackUser.id === body.user.id) {
            //     saveData.reporterSlackUser = slackUser;
            // }
            if (track.users && track.users.includes(slackUser.profile.display_name)) {
                saveData.trackSlackUsers.push(slackUser);
            }
        });

        return createJiraIssue(setCookie, makeJiraReportIssuePayload(saveData));
    })
    .then(res => {
        saveData.jiraReport.issueKey = res.data.key;
        return doJiraIssueTransition(setCookie, saveData.jiraReport.issueKey, makeJiraReportTransitionReadyPayload(saveData.platform));
    })
    .then(res => sendSlackMsg(makeReportSavedMsgPayload(saveData)))
    .then(res => sendSlackMsg(body.response_url, makeReportSavedMsgPayload(input)))
    .then(res => editJiraIssues(platforms))
    .then(res => console.log(res.data))
    .catch(err => console.log(JSON.stringify(err.response.data)));