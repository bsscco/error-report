console.log(new Date().toTimeString());

const fs = require('fs');
const config = JSON.parse(fs.readFileSync(__dirname + '/config.json'));

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const {google} = require('googleapis');
const path = require('path');
const urlencode = require('urlencode');
const moment = require('moment');
const JsonDB = require('node-json-db');
const db = new JsonDB("reporting-tmp-db", true, true);

const app = express();
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());

app.get('/', (req, res) => res.status(200).send('Hello, Error Report!!').end());

app.post('/command', (req, res) => {
    console.log(JSON.stringify(req.body, null, 2));
    res.send('');

    openSlackDlg(req.body.trigger_id, makeReportDlgPayload())
        .then(res => console.log(JSON.stringify(res.data, null, 2)))
        .catch(err => console.log(err));
});

app.post('/interact', (req, res) => {
    const body = JSON.parse(req.body.payload);
    console.log(JSON.stringify(body, null, 2));
    res.send('');

    if (body.callback_id === 'save_report') {
        saveReport(body);
    }
    else if (body.actions) {
        const actionId = body.actions[0].action_id;
        if (actionId === 'set_version') {
            const input = db.getData('/' + body.user.id);
            input.version = body.actions[0].selected_option;
            db.push('/' + body.user.id, input);

            sendAdditionalInputMsg(body, input);
        }
        else if (actionId === 'set_priority') {
            const input = db.getData('/' + body.user.id);
            input.priority = body.actions[0].selected_option;
            db.push('/' + body.user.id, input);

            sendAdditionalInputMsg(body, input);
        }
        else if (actionId === 'set_reproducing') {
            const input = db.getData('/' + body.user.id);
            input.reproducing = body.actions[0].selected_option;
            db.push('/' + body.user.id, input);

            sendAdditionalInputMsg(body, input);
        }
        else if (actionId === 'set_track') {
            const input = db.getData('/' + body.user.id);
            input.track = body.actions[0].selected_option;
            db.push('/' + body.user.id, input);

            sendAdditionalInputMsg(body, input);
        }
        else if (actionId === 'set_developer') {
            const input = db.getData('/' + body.user.id);
            input.assignee = body.actions[0].selected_option;
            db.push('/' + body.user.id, input);

            sendAdditionalInputMsg(body, input);
        }
        else if (actionId === 'set_channel') {
            const input = db.getData('/' + body.user.id);
            input.channel = body.actions[0].selected_option;
            db.push('/' + body.user.id, input);

            sendAdditionalInputMsg(body, input);
        }
        else if (actionId === 'complete') {
            completeReport(body);
        }
    }
});

function saveReport(body) {
    const input = body.submission;

    loginJiraAndGetVersionsPriorities()
        .then(jiraData => {
            input.priority = {
                text: {
                    type: "plain_text",
                    text: `${jiraData.options.priorities[2].name}(${jiraData.options.priorities[2].description})`,
                },
                value: jiraData.options.priorities[2].id
            };
            input.reproducing = {
                text: {
                    type: "plain_text",
                    text: '재현 가능',
                },
                value: 'true'
            };
            db.push('/' + body.user.id, input);

            return sendSlackMsg(body.response_url, makeAdditionalInputMsgPayload(input, jiraData.options));
        })
        .then(res => console.log(JSON.stringify(res.data, null, 2)))
        .catch(err => console.log(err.toString()));
}

function sendAdditionalInputMsg(body, input) {
    loginJiraAndGetVersionsPriorities()
        .then(jiraData => sendSlackMsg(body.response_url, makeAdditionalInputMsgPayload(input, jiraData.options)))
        .then(res => console.log(JSON.stringify(res.data, null, 2)))
        .catch(err => console.log(err.toString()));
}

function completeReport(body) {
    const saveData = {trackSlackUsers: []};
    const input = db.getData('/' + body.user.id);
    saveData.input = input;

    if (!checkInputValidation(body, input)) {
        return;
    }

    saveData.platform = getPlatformByAssignee(input.assignee.value);
    let setCookie = '';
    let slackUsers = [];

    console.log('loginJira()');
    loginJira()
        .then(res => {
            setCookie = res.headers['set-cookie'].join(';');

            console.log('getAppVersions()');
            return getAppVersions(setCookie);
        })
        .then(versions => {
            if (saveData.platform.platform === 'Web' || saveData.platform.platform === 'Server') {
                versions = versions.filter(version => version.name.includes(saveData.platform.platform + ' ') && !version.name.includes('AB') && !version.name.includes('QA'));
                versions.sort((a, b) => b.id - a.id);

                const needReleased = (input.channel.value !== 'CK7T2606Q'/*QA*/ && input.channel.value !== 'C96R019T2'/*사내배포*/);
                for (const idx in versions) {
                    const version = versions[idx];
                    if (version.released === needReleased) {
                        input.version = {
                            text: {
                                type: "plain_text",
                                text: version.name,
                            },
                            value: version.id
                        };
                        break;
                    }
                }
            }

            console.log('getSlackUsers()');
            return getSlackUsers();
        })
        .then(list => {
            slackUsers = list;

            console.log('getUserGroups()');
            return getUserGroups();
        })
        .then(userGroups => {
            const track = config.track_list[input.track.value];
            for (const idx in userGroups) {
                const userGroup = userGroups[idx];
                if (userGroup.handle === track.user_group_handle) {
                    saveData.trackSlackUserGroup = userGroup;
                    break;
                }
            }

            console.log('getJiraUsers()');
            return getJiraUsers(setCookie);
        })
        .then(jiraUsers => {
            const track = config.track_list[input.track.value];
            const assignee = input.assignee.value;
            slackUsers.filter(slackUser => {
                jiraUsers.filter(jiraUser => {
                    if (jiraUser.displayName === assignee && slackUser.profile.display_name === assignee) {
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

            console.log('createJiraIssue()');
            return createJiraIssue(setCookie, makeReportIssuePayload(saveData));
        })
        .then(res => {
            saveData.jiraReport.issueKey = res.data.key;

            console.log('doJiraIssueTransition()');
            return doJiraIssueTransition(setCookie, saveData.jiraReport.issueKey, makeJiraReportTransitionReadyPayload(saveData.platform));
        })
        .then(res => {
            console.log('sendSlackMsg(", makeReportSavedMsgPayload(saveData, true))');
            return sendSlackMsg('', makeReportSavedMsgPayload(saveData, true));
        })
        .then(res => {
            saveData.slackMsg = {ts: res.data.ts};

            console.log('sendSlackMsg(body.response_url, makeReportSavedMsgPayload(saveData, false))');
            return sendSlackMsg(body.response_url, makeReportSavedMsgPayload(saveData, false));
        })
        .then(res => {
            console.log('editJiraIssue()');
            return editJiraIssue(setCookie, saveData.jiraReport.issueKey, makeJiraReportSlackLinkAdditionPayload(saveData));
        })
        .then(res => {
            console.log('getGoogleApiAccessToken()');
            return getGoogleApiAccessToken();
        })
        .then(res => {
            console.log('getThisMonthReportingAggregationSheet()');
            return getThisMonthReportingAggregationSheet();
        })
        .then(res => {
            if (res == null) {
                console.log('appendThisMonthReportingAggregationSheet()');
                return appendThisMonthReportingAggregationSheet()
                    .then(res => {
                        console.log('initThisMonthReportingAggregationSheet()');
                        return initThisMonthReportingAggregationSheet();
                    })
                    .then(res => {
                        console.log('getReportingAggregationRows()');
                        return getReportingAggregationRows();
                    });
            } else {
                console.log('getReportingAggregationRows()');
                return getReportingAggregationRows();
            }
        })
        .then(rows => {
            const foundRow = rows.find(row => row.nickname === '@' + saveData.reporterSlackUser.profile.display_name);
            let rewards = 500;
            if (foundRow == null) {
                console.log('appendReportingAggregationRow()');
                if (input.channel.value === 'C8U11TLBS'/*앱*/) {
                    return appendReportingAggregationRow(
                        '@' + saveData.reporterSlackUser.profile.display_name,
                        rewards,
                        1,
                        saveData.jiraReport.issueKey,
                        0,
                        '',
                        0,
                        '',
                        0,
                        ''
                    );
                } else if (input.channel.value === 'C713L3CTX'/*웹*/) {
                    return appendReportingAggregationRow(
                        '@' + saveData.reporterSlackUser.profile.display_name,
                        rewards,
                        0,
                        '',
                        1,
                        saveData.jiraReport.issueKey,
                        0,
                        '',
                        0,
                        ''
                    );
                } else if (input.channel.value === 'C96R019T2'/*사내배포*/) {
                    rewards = 1000;
                    return appendReportingAggregationRow(
                        '@' + saveData.reporterSlackUser.profile.display_name,
                        rewards,
                        0,
                        '',
                        0,
                        '',
                        1,
                        saveData.jiraReport.issueKey,
                        0,
                        ''
                    );
                } else if (input.channel.value === 'CK7T2606Q'/*QA*/) {
                    return appendReportingAggregationRow(
                        '@' + saveData.reporterSlackUser.profile.display_name,
                        rewards,
                        0,
                        '',
                        0,
                        '',
                        0,
                        '',
                        1,
                        saveData.jiraReport.issueKey
                    );
                }
            } else {
                console.log('updateReportingAggregationRow()');
                if (input.channel.value === 'C8U11TLBS'/*앱*/) {
                    return updateReportingAggregationRow(
                        foundRow.idx,
                        foundRow.nickname,
                        foundRow.rewards + rewards,
                        foundRow.app_cnt + 1,
                        (foundRow.app_cards === '' ? '' : foundRow.app_cards + ', ') + saveData.jiraReport.issueKey,
                        foundRow.web_cnt,
                        foundRow.web_cards,
                        foundRow.test_cnt,
                        foundRow.test_cards,
                        foundRow.qa_cnt,
                        foundRow.qa_cards
                    );
                } else if (input.channel.value === 'C713L3CTX'/*웹*/) {
                    return updateReportingAggregationRow(
                        foundRow.idx,
                        foundRow.nickname,
                        foundRow.rewards + rewards,
                        foundRow.app_cnt,
                        foundRow.app_cards,
                        foundRow.web_cnt + 1,
                        (foundRow.web_cards === '' ? '' : foundRow.web_cards + ', ') + saveData.jiraReport.issueKey,
                        foundRow.test_cnt,
                        foundRow.test_cards,
                        foundRow.qa_cnt,
                        foundRow.qa_cards
                    );
                } else if (input.channel.value === 'C96R019T2'/*사내배포*/) {
                    rewards = 1000;
                    return updateReportingAggregationRow(
                        foundRow.idx,
                        foundRow.nickname,
                        foundRow.rewards + rewards,
                        foundRow.app_cnt,
                        foundRow.app_cards,
                        foundRow.web_cnt,
                        foundRow.web_cards,
                        foundRow.test_cnt + 1,
                        (foundRow.test_cards === '' ? '' : foundRow.test_cards + ', ') + saveData.jiraReport.issueKey,
                        foundRow.qa_cnt,
                        foundRow.qa_cards
                    );
                } else if (input.channel.value === 'CK7T2606Q'/*QA*/) {
                    return updateReportingAggregationRow(
                        foundRow.idx,
                        foundRow.nickname,
                        foundRow.rewards + rewards,
                        foundRow.app_cnt,
                        foundRow.app_cards,
                        foundRow.web_cnt,
                        foundRow.web_cards,
                        foundRow.test_cnt,
                        foundRow.test_cards,
                        foundRow.qa_cnt + 1,
                        (foundRow.qa_cards === '' ? '' : foundRow.qa_cards + ', ') + saveData.jiraReport.issueKey
                    );
                }
            }
        })
        .then(res => {
            db.delete('/' + body.user.id);

            console.log(JSON.stringify(res.data, null, 2));
        })
        .catch(err => console.log(err.toString()));
}

function checkInputValidation(body, input) {
    let errorMessage = '';
    if (input.version == null) {
        errorMessage += '`버전` ';
    }
    if (input.priority == null) {
        errorMessage += '`심각도` ';
    }
    if (input.reproducing == null) {
        errorMessage += '`재현여부` ';
    }
    if (input.track == null) {
        errorMessage += '`예상 담당트랙` ';
    }
    if (input.assignee == null) {
        errorMessage += '`예상 담당개발자` ';
    }
    if (input.channel == null) {
        errorMessage += '`채널` ';
    }
    if (errorMessage) {
        errorMessage += '(을)를 선택해주세요!';

        loginJiraAndGetVersionsPriorities()
            .then(jiraData => {
                const payload = makeAdditionalInputMsgPayload(input, jiraData.options);
                payload.blocks.push({
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": errorMessage
                    }
                });
                return sendSlackMsg(body.response_url, payload);
            })
            .then(res => console.log(JSON.stringify(res.data, null, 2)))
            .catch(err => console.log(JSON.stringify(err.response.data, null, 2)));
        return false;
    }
    return true;
}

function getPlatformByAssignee(assignee) {
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
        })
        .then(res => new Promise(resolve => resolve(res.data.usergroups)));
}

function openSlackDlg(triggerId, payload) {
    return axios
        .post('https://slack.com/api/dialog.open', JSON.stringify({
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
    return {
        callback_id: 'save_report',
        title: '오류리포팅(스크린샷은 댓글로)',
        submit_label: '등록',
        elements: [
            {
                type: 'textarea',
                label: '발생 현상',
                name: 'situation',
                placeholder: '필터를 누르면 강제종료 됩니다.',
                value: null,
                optional: false,
                hint: '스크린샷은 스레드에 댓글로 달아주세요.',
            },
            {
                type: 'textarea',
                label: '발생 경로',
                name: 'path',
                value: null,
                placeholder: '발생 경로, 회원 아이디, 콘텐츠 아이디',
                optional: false
            },
        ]
    };
}

function makeAdditionalInputMsgPayload(input, options) {
    const json = {
        blocks: [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": `*발생 현상*\n${input.situation}\n*발생 경로*\n${input.path}`
                },
                "accessory": {
                    "type": "image",
                    "image_url": "https://avatars.slack-edge.com/2019-01-29/536255934133_edae2d398751c934032e_512.png",
                    "alt_text": "error? bug?"
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "*아래 추가정보를 모두 입력하고 완료버튼을 눌러야 등록됩니다!*"
                }
            },
            {
                "type": "divider"
            },
        ]
    };

    const versionSection = {
        type: "section",
        text: {
            type: "mrkdwn",
            text: "1️⃣ 발생버전 선택"
        },
        accessory: {
            action_id: 'set_version',
            type: "static_select",
            placeholder: {
                type: "plain_text",
                text: "Select an item",
            },
            options: options.versions
                .filter(version => !version.name.includes('Web') && !version.name.includes('Server'))
                .map(version => ({
                        text: {
                            type: "plain_text",
                            text: version.name,
                        },
                        value: version.id
                    })
                ),
        }
    };
    versionSection.accessory.options.splice(0, 0, {
        text: {
            type: "plain_text",
            text: 'Server 최신버전',
        },
        value: '-1'
    });
    versionSection.accessory.options.splice(0, 0, {
        text: {
            type: "plain_text",
            text: 'Web 최신버전',
        },
        value: '-2'
    });

    if (input.version) {
        versionSection.accessory.initial_option = input.version;
    }
    json.blocks.push(versionSection);

    const prioritySection = {
        type: "section",
        text: {
            type: "mrkdwn",
            text: "2️⃣ 심각도 선택"
        },
        accessory: {
            action_id: 'set_priority',
            type: "static_select",
            placeholder: {
                type: "plain_text",
                text: "Select an item",
            },
            options: options.priorities.map(priority => ({
                text: {
                    type: "plain_text",
                    text: `${priority.name}(${priority.description})`,
                },
                value: priority.id
            })),
            initial_option: {
                text: {
                    type: "plain_text",
                    text: `${options.priorities[2].name}(${options.priorities[2].description})`,
                },
                value: options.priorities[2].id
            }
        }
    };
    if (input.priority) {
        prioritySection.accessory.initial_option = input.priority;
    }
    json.blocks.push(prioritySection);

    const reproducingSection = {
        type: "section",
        text: {
            type: "mrkdwn",
            text: "3️⃣ 재현가능여부 선택"
        },
        accessory: {
            action_id: 'set_reproducing',
            type: "static_select",
            placeholder: {
                type: "plain_text",
                text: "Select an item",
            },
            options: [
                {
                    text: {
                        type: "plain_text",
                        text: '재현 가능',
                    },
                    value: 'true'
                },
                {
                    text: {
                        type: "plain_text",
                        text: '재현 불가능',
                    },
                    value: 'false'
                },
            ],
            initial_option: {
                text: {
                    type: "plain_text",
                    text: '재현 가능',
                },
                value: 'true'
            }
        }
    };
    if (input.reproducing) {
        reproducingSection.accessory.initial_option = input.reproducing;
    }
    json.blocks.push(reproducingSection);

    const trackSection = {
        type: "section",
        text: {
            type: "mrkdwn",
            text: "4️⃣ 예상 담당트랙 선택"
        },
        accessory: {
            action_id: 'set_track',
            type: "static_select",
            placeholder: {
                type: "plain_text",
                text: "Select an item",
                emoji: true
            },
            options: config.track_list.map(track => ({
                text: {
                    type: 'plain_text',
                    text: track.label,
                    emoji: true
                },
                value: track.value
            }))
        }
    }
    if (input.track) {
        trackSection.accessory.initial_option = input.track;
    }
    json.blocks.push(trackSection);

    const developerSection = {
        type: "section",
        text: {
            type: "mrkdwn",
            text: "5️⃣ 예상 담당개발자 선택"
        },
        accessory: {
            action_id: 'set_developer',
            type: "static_select",
            placeholder: {
                type: "plain_text",
                text: "Select an item",
                emoji: true
            },
            options: config.developer_list.map(track => ({
                text: {
                    type: 'plain_text',
                    text: track.label,
                    emoji: true
                },
                value: track.value
            })),
        }
    };
    if (input.assignee) {
        developerSection.accessory.initial_option = input.assignee;
    }
    json.blocks.push(developerSection);

    const channelSection = {
        type: "section",
        text: {
            type: "mrkdwn",
            text: "6️⃣ 리포팅 채널 선택"
        },
        accessory: {
            action_id: 'set_channel',
            type: "static_select",
            placeholder: {
                type: "plain_text",
                text: "Select an item",
                emoji: true
            },
            options: config.channel_list.map(track => ({
                text: {
                    type: 'plain_text',
                    text: track.label,
                    emoji: true
                },
                value: track.value
            })),
        }
    };
    if (input.channel) {
        channelSection.accessory.initial_option = input.channel;
    }
    json.blocks.push(channelSection);

    json.blocks.push(
        {
            "type": "actions",
            "elements": [
                {
                    action_id: 'complete',
                    "type": "button",
                    "text": {
                        "type": "plain_text",
                        "emoji": true,
                        "text": "완료"
                    },
                    "style": "primary",
                    "value": "complete"
                }
            ]
        });

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
        title: '발생 현상',
        value: saveData.input.situation,
        short: false
    });
    fields.push({
        title: '발생 경로',
        value: saveData.input.path,
        short: false
    });
    fields.push({
        title: '발생 버전',
        value: saveData.input.version.text.text,
        short: false
    });
    fields.push({
        title: '심각도',
        value: saveData.input.priority.text.text,
        short: false
    });
    fields.push({
        title: '재현여부',
        value: saveData.input.reproducing.text.text,
        short: false
    });
    fields.push({
        title: '예상 담당트랙',
        value: saveData.input.track.text.text + '\n<!subteam^' + saveData.trackSlackUserGroup.id + '|' + saveData.trackSlackUserGroup.handle + '>',
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
        title: '리포팅 채널',
        value: saveData.input.channel.text.text,
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
        json.channel = saveData.input.channel.value;
        if (saveData.input.path === 'tttt') {
            json.channel = 'CASU375FD';
        }
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

function loginJiraAndGetVersionsPriorities() {
    const jiraData = {
        setCookie: '',
        options: {
            versions: [],
            priorities: [],
        },
    };

    return loginJira()
        .then(res => {
            jiraData.setCookie = res.headers['set-cookie'].join(';');
            return getAppVersions(jiraData.setCookie);
        })
        .then(versions => {
            // { version
            //     self: "http://jira.dailyhou.se/rest/api/2/version/12147",
            //     id: "12147",
            //     name: "And 8.18.7",
            //     archived: false,
            //     released: true,
            //     releaseDate: "2019-02-19",
            //     userReleaseDate: "2019/02/19 00:00 AM",
            //     projectId: 10400,
            // },
            const andVersions = [];
            const iosVersions = [];
            const webVersions = [];
            const serverVersions = [];
            versions.forEach(version => {
                if (version.name.includes('AB') || version.name.includes('QA')) {
                    return;
                }
                if (andVersions.length < 5 && version.name.includes('And ')) {
                    andVersions.push(version);
                }
                else if (iosVersions.length < 5 && version.name.includes('iOS ')) {
                    iosVersions.push(version);
                }
                else if (webVersions.length < 5 && version.name.includes('Web ')) {
                    webVersions.push(version);
                }
                else if (serverVersions.length < 5 && version.name.includes('Server ')) {
                    serverVersions.push(version);
                }
            });
            andVersions.sort((a, b) => b.id - a.id)
            iosVersions.sort((a, b) => b.id - a.id)
            webVersions.sort((a, b) => b.id - a.id)
            serverVersions.sort((a, b) => b.id - a.id)
            jiraData.options.versions = [...andVersions, ...iosVersions, ...webVersions, ...serverVersions];

            return getPriorities(jiraData.setCookie);
        })
        .then(priorities => {
            // { priority
            //     self: "http://jira.dailyhou.se/rest/api/2/priority/1",
            //         statusColor: "#ff0000",
            //     description: "This problem will block progress.",
            //     iconUrl: "http://jira.dailyhou.se/images/icons/priorities/major.svg",
            //     name: "Highest",
            //     id: "1",
            // },
            jiraData.options.priorities = priorities;

            return new Promise(resolve => resolve(jiraData));
        })
}

function getAppVersions(setCookie) {
    return axios
        .get(config.jira_server_domain + '/rest/api/2/project/OK/versions',
            {
                headers: {
                    'Cookie': setCookie,
                    'Content-Type': 'application/json'
                }
            }
        )
        .then(res => res.data);
}

function getPriorities(setCookie) {
    return axios
        .get(config.jira_server_domain + '/rest/api/2/priority',
            {
                headers: {
                    'Cookie': setCookie,
                    'Content-Type': 'application/json'
                }
            }
        )
        .then(res => new Promise(resolve => resolve(res.data)));
}

function getJiraUsers(setCookie) {
    return axios
        .get(config.jira_server_domain + '/rest/api/2/group/member?groupname=jira-software-users',
            {
                headers: {
                    'Cookie': setCookie,
                    'Content-Type': 'application/json'
                }
            }
        )
        .then(res => new Promise(resolve => resolve(res.data.values)));
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

function makeReportIssuePayload(saveData) {
    saveData.jiraReport = {};
    saveData.jiraReport.description = '';
    saveData.jiraReport.description += '\nh2. 보고자 \n\n' + saveData.reporterSlackUser.profile.display_name;
    saveData.jiraReport.description += '\nh2. 발생 현상 \n\n' + saveData.input.situation;
    saveData.jiraReport.description += '\nh2. 발생 경로 \n\n' + saveData.input.path;
    saveData.jiraReport.description += '\nh2. 발생 버전 \n\n' + saveData.input.version.text.text;
    saveData.jiraReport.description += '\nh2. 심각도 \n\n' + saveData.input.priority.text.text;
    saveData.jiraReport.description += '\nh2. 재현 여부 \n\n' + saveData.input.reproducing.text.text;
    saveData.jiraReport.description += '\n\nh2. 예상 담당트랙 \n\n' + saveData.input.track.text.text;
    saveData.jiraReport.description += '\nh2. 예상 담당개발자 \n\n' + saveData.input.assignee.text.text;
    saveData.jiraReport.description += '\nh2. 리포팅 채널 \n\n' + saveData.input.channel.text.text;

    const json = {
        "fields": {
            "project": {"id": "10400"/*OK-KANBAN*/},
            "issuetype": {"id": "10103" /*BugType*/},
            "summary": '[' + saveData.platform.platform + '] ' + convertUtf8mb4(saveData.input.situation).replace(/\n/g, ' ').substr(0, 100),
            "assignee": {"name": saveData.assigneeJiraUser.name},
            "reporter": {"name": "slack_bug"},
            "priority": {"id": saveData.input.priority.value},
            "versions": [{"id": saveData.input.version.value}],
            "description": convertUtf8mb4(saveData.jiraReport.description),
            "components": [saveData.platform.component],
            "customfield_11100": {"id": "10809" /*미지정*/},
            "customfield_11101": {"id": config.channel_list.find(channel => channel.value === saveData.input.channel.value).customfield_11101},
            "customfield_11102": {"id": saveData.input.reproducing.value === 'false' ? "10817" : "10816"}
        }
    };
    const track = config.track_list[saveData.input.track.value];
    if (track.jira_label) {
        json.fields.labels = [track.jira_label];
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
    saveData.jiraReport.description += '\nh2. 슬랙링크 \n\n' + config.slack_domain + '/archives/' + saveData.input.channel.value + '/p' + saveData.slackMsg.ts.replace('.', '');
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

// google API
const tokenStorage = {
    access_token: null,
    token_type: null,
    expiry_date: null
};

function getGoogleApiAccessToken() {
    return new Promise(function (resolve, reject) {
        const jwt = new google.auth.JWT(
            null,
            path.join(__dirname, 'google-service-account.json'), //키 파일의 위치
            null,
            [
                'https://www.googleapis.com/auth/spreadsheets.readonly',
                'https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/drive.readonly',
                'https://www.googleapis.com/auth/drive.file',
                'https://www.googleapis.com/auth/drive'
            ],
            ''
        );

        jwt.authorize(function (err, tokens) {
            if (err) {
                reject(err)
                return;
            }
            tokenStorage.access_token = tokens.access_token;
            tokenStorage.token_type = tokens.token_type;
            tokenStorage.expiry_date = tokens.expiry_date;
            resolve();
        });
    });
}

function getThisMonthReportingAggregationSheet() {
    return axios
        .get('https://sheets.googleapis.com/v4/spreadsheets/' + urlencode(config.sheet.sheets_id), {
            headers: {
                Authorization: 'Bearer ' + tokenStorage.access_token
            }
        })
        .then(res => {
            for (const idx in res.data.sheets) {
                const sheet = res.data.sheets[idx];
                if (sheet.properties.title === moment().format('YY년M월')) {
                    return new Promise(resolve => resolve(sheet));
                }
            }
            return new Promise(resolve => resolve(null));
        })
}

function appendThisMonthReportingAggregationSheet() {
    const requestBody = {
        "requests": [
            {
                "addSheet": {
                    "properties": {
                        "title": moment().format('YY년M월')
                    }
                }
            }
        ]
    };
    return axios.post('https://sheets.googleapis.com/v4/spreadsheets/' + urlencode(config.sheet.sheets_id) + ':batchUpdate', requestBody,
        {
            headers: {
                Authorization: 'Bearer ' + tokenStorage.access_token
            }
        }
    );
}

function initThisMonthReportingAggregationSheet() {
    const requestBody = {
        values: [
            [
                '합계',
                '=sum(' + config.sheet.sheet_fields.rewards_col + config.sheet.sheet_fields.range_start_row + ':' + config.sheet.sheet_fields.rewards_col + ')',
                '=sum(' + config.sheet.sheet_fields.app_cnt_col + config.sheet.sheet_fields.range_start_row + ':' + config.sheet.sheet_fields.app_cnt_col + ')',
                '',
                '=sum(' + config.sheet.sheet_fields.web_cnt_col + config.sheet.sheet_fields.range_start_row + ':' + config.sheet.sheet_fields.web_cnt_col + ')',
                '',
                '=sum(' + config.sheet.sheet_fields.test_cnt_col + config.sheet.sheet_fields.range_start_row + ':' + config.sheet.sheet_fields.test_cnt_col + ')',
                '',
                '=sum(' + config.sheet.sheet_fields.qa_cnt_col + config.sheet.sheet_fields.range_start_row + ':' + config.sheet.sheet_fields.qa_cnt_col + ')',
                ''
            ],
            ['', '금액', '앱', '앱 카드', '웹', '웹 카드', '사내배포', '사내배포 카드', 'QA', 'QA 카드'],
        ]
    };
    return axios.put('https://sheets.googleapis.com/v4/spreadsheets/' + urlencode(config.sheet.sheets_id) + '/values/' +
        urlencode(moment().format('YY년M월') + '!' + config.sheet.sheet_fields.range_start_col + '1:' + config.sheet.sheet_fields.range_end_col + '2') +
        '?valueInputOption=USER_ENTERED&responseValueRenderOption=FORMULA', requestBody,
        {
            headers: {
                Authorization: 'Bearer ' + tokenStorage.access_token
            }
        }
    );
}

function getReportingAggregationRows() {
    return axios
        .get('https://sheets.googleapis.com/v4/spreadsheets/' + urlencode(config.sheet.sheets_id) + '/values/' + urlencode(moment().format('YY년M월') + '!' + config.sheet.sheet_fields.range_start_col + '' + config.sheet.sheet_fields.range_start_row + ':' + config.sheet.sheet_fields.range_end_col), {
            headers: {
                Authorization: 'Bearer ' + tokenStorage.access_token
            }
        })
        .then(res => {
            const reportingAggregationRows = [];
            for (const idx in res.data.values) {
                const row = res.data.values[idx];
                const reportingAggregationRow = {
                    nickname: row[config.sheet.sheet_fields.nickname_col_idx],
                    rewards: parseInt(row[config.sheet.sheet_fields.rewards_col_idx].replace(',', '')),
                    app_cnt: parseInt(row[config.sheet.sheet_fields.app_cnt_col_idx].replace(',', '')),
                    app_cards: row[config.sheet.sheet_fields.app_cards_col_idx],
                    web_cnt: parseInt(row[config.sheet.sheet_fields.web_cnt_col_idx].replace(',', '')),
                    web_cards: row[config.sheet.sheet_fields.web_cards_col_idx],
                    test_cnt: parseInt(row[config.sheet.sheet_fields.test_cnt_col_idx].replace(',', '')),
                    test_cards: row[config.sheet.sheet_fields.test_cards_col_idx],
                    idx: Number(idx)
                };
                reportingAggregationRows.push(reportingAggregationRow);
            }
            return new Promise(resolve => resolve(reportingAggregationRows));
        })
}

function appendReportingAggregationRow(nickname, rewards, appCnt, appCards, webCnt, webCards, testCnt, testCards, qaCnt, qaCards) {
    const requestBody = {
        values: [[nickname, rewards, appCnt, appCards, webCnt, webCards, testCnt, testCards, qaCnt, qaCards]]
    };
    return axios.post('https://sheets.googleapis.com/v4/spreadsheets/' + urlencode(config.sheet.sheets_id) + '/values/' +
        urlencode(moment().format('YY년M월') + '!' + config.sheet.sheet_fields.range_start_col + ':' + config.sheet.sheet_fields.range_end_col) +
        ':append?valueInputOption=USER_ENTERED', requestBody,
        {
            headers: {
                Authorization: 'Bearer ' + tokenStorage.access_token
            }
        }
    );
}

function updateReportingAggregationRow(rowIdx, nickname, rewards, appCnt, appCards, webCnt, webCards, testCnt, testCards, qaCnt, qaCards) {
    const requestBody = {
        values: [[nickname, rewards, appCnt, appCards, webCnt, webCards, testCnt, testCards, qaCnt, qaCards]]
    };
    return axios.put('https://sheets.googleapis.com/v4/spreadsheets/' + urlencode(config.sheet.sheets_id) + '/values/' +
        urlencode(moment().format('YY년M월') + '!' + config.sheet.sheet_fields.nickname_col_idx + '' + (config.sheet.sheet_fields.range_start_row + rowIdx) + ':' + config.sheet.sheet_fields.qa_cards_col_idx + '' + (config.sheet.sheet_fields.range_start_row + rowIdx)) +
        '?valueInputOption=USER_ENTERED', requestBody,
        {
            headers: {
                Authorization: 'Bearer ' + tokenStorage.access_token
            }
        }
    );
}

// Start the server
// const PORT = process.env.PORT || 10000;
const PORT = process.env.PORT || 55000;
app.listen(PORT, () => {
    console.log(`App listening on port ${PORT}`);
    console.log('Press Ctrl+C to quit.');
});