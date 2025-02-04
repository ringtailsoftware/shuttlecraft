const fetch = (url, type, payload = undefined) => {
    return new Promise((resolve, reject) => {
        const Http = new XMLHttpRequest();
        Http.open(type, url);
        // TODO: should be a parameter
        Http.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
        Http.send(payload);

        Http.onreadystatechange = () => {
            if (Http.readyState == 4 && Http.status == 200) {
                resolve(Http.responseText);
            } else if (Http.readyState == 4 && Http.status >= 300) {
                reject(Http.statusText);
            }

        }
    });
}

const setCookie = (name,value,days) => {
    var expires = "";
    if (days) {
        var date = new Date();
        date.setTime(date.getTime() + (days*24*60*60*1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + (value || "")  + expires + "; path=/";
}
const getCookie = (name) => {
    var nameEQ = name + "=";
    var ca = document.cookie.split(';');
    for(var i=0;i < ca.length;i++) {
        var c = ca[i];
        while (c.charAt(0)==' ') c = c.substring(1,c.length);
        if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length,c.length);
    }
    return null;
}

const beep = () => {
    console.log("BEEP!");
    var snd = new Audio('/audio/beep.wav');
    snd.play();
}

const app = {
    firstPoll: true,
    newPosts: 0,
    newNotifications: 0,
    latestPost: (date) => {
        setCookie('latestPost', date, 7);
    },
    latestNotification: (date) => {
        setCookie('latestNotification', date, 7);
    },
    toggleCW: (id) => {
        if (document.getElementById(id).classList.contains('collapsed')) {
            document.getElementById(id).classList.remove('collapsed');
        } else {
            document.getElementById(id).classList.add('collapsed');
        }
    },
    alertNewPosts: (meta) => {
        const newPosts = document.getElementById('newPosts') || document.getElementById('newPostsBadge');
        if (newPosts) {
            if (meta.newPosts > 0) {
                if (meta.newPosts > app.newPosts) {
                    beep();
                }
                app.newPosts = meta.newPosts;
                newPosts.innerHTML = `${meta.newPosts}<span> unread</span>`;
                newPosts.hidden = false;
            } else {
                newPosts.innerHTML = '';
                newPosts.hidden = true;
            }
        }
        const newNotifications = document.getElementById('newNotifications') || document.getElementById('newNotificationsBadge');
        if (newNotifications) {
            if (meta.newNotifications > 0) {
                if (meta.newNotifications > app.newNotifications) {
                    beep();
                }
                app.newNotifications = meta.newNotifications;
                newNotifications.innerHTML = `${meta.newNotifications}<span> new</span>`;
                newNotifications.hidden = false;
            } else {
                newNotifications.innerHTML = '';
                newNotifications.hidden = true;
            }
        }
        const newDMs = document.getElementById('newDMs') || document.getElementById('newDMsBadge');
        if (newDMs) {
            if (meta.newDMs > 0) {
                if (meta.newDMs > app.newDMs) {
                    beep();
                }
                app.newDMs = meta.newDMs;
                newDMs.innerHTML = `${meta.newDMs}<span> new</span>`;
                newDMs.hidden = false;
            } else {
                newDMs.innerHTML = '';
                newDMs.hidden = true;
            }
        }

    },
    pollForPosts: () => {
        fetch('/private/poll' + (app.firstPoll ? '?nowait=1' : ''),'get').then((json) => {
            app.firstPoll = false;
            const res = JSON.parse(json);
            app.alertNewPosts(res);
            setTimeout(() => app.pollForPosts(), 1000); // poll every 1 seconds, endpoint will stall until event occurs
        }).catch((err) => {
            console.error(err);
            setTimeout(() => app.pollForPosts(), 1000); // poll every 1 seconds, endpoint will stall until event occurs
        });
    },
    toggleBoost: (el, postId) => {
        const Http = new XMLHttpRequest();
        const proxyUrl ='/private/boost';
        Http.open("POST", proxyUrl);
        Http.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
        Http.send(JSON.stringify({
            post: postId,
        }));

        Http.onreadystatechange = () => {
            if (Http.readyState == 4 && Http.status == 200) {
                const resRaw = Http.responseText;
                const res = JSON.parse(resRaw);
                if (res.isBoosted) {
                    console.log('boosted!');
                    el.classList.add("active");
                } else {
                    console.log('unboosted');
                    el.classList.remove("active");
                }
            } else {
                console.error('HTTP PROXY CHANGE', Http);
            }
        }
        return false;
    },
    toggleLike: (el, postId) => {
        const Http = new XMLHttpRequest();
        const proxyUrl ='/private/like';
        Http.open("POST", proxyUrl);
        Http.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
        Http.send(JSON.stringify({
            post: postId,
        }));

        Http.onreadystatechange = () => {
            if (Http.readyState == 4 && Http.status == 200) {
                const resRaw = Http.responseText;
                const res = JSON.parse(resRaw);
                if (res.isLiked) {
                    console.log('liked!');
                    el.classList.add("active");
                } else {
                    console.log('unliked');
                    el.classList.remove("active");
                }
            } else {
                console.error('HTTP PROXY CHANGE', Http);
            }
        }
        return false;
    },
    followuploaded: () => {
        app.readAttachment('followingupload').then((att) => {
            const Http = new XMLHttpRequest();
            const proxyUrl ='/private/importfollowing';
            Http.open("POST", proxyUrl);
            Http.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
            Http.send(JSON.stringify({
                attachment_following: att,
            }));

            Http.onreadystatechange = () => {
                if (Http.readyState == 4 && Http.status == 200) {
                    console.log('posted!');
                    window.location = '/private/settings';
                } else {
                    console.error('HTTP PROXY CHANGE', Http);
                }
            }
        });
        return false;
    },
    settings: () => {
        const summary = document.getElementById('summary');
        let attachment_header;
        let attachment_avatar;

        app.readAttachment('avatarupload').then((att) => {
            attachment_avatar = att;
            return app.readAttachment('headerupload').then((att) => {
                attachment_header = att;

                const Http = new XMLHttpRequest();
                const proxyUrl ='/private/settings';
                Http.open("POST", proxyUrl);
                Http.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
                Http.send(JSON.stringify({
                    attachment_avatar: attachment_avatar,
                    attachment_header: attachment_header,
                    account: {
                        actor: {
                            summary: summary.value
                        }
                    }
                }));

                Http.onreadystatechange = () => {
                    if (Http.readyState == 4 && Http.status == 200) {
                        console.log('posted!');
                        window.location = '/private/settings';
                    } else {
                        console.error('HTTP PROXY CHANGE', Http);
                    }
                }
            });
        });
        return false;
    },
    readAttachment: async (id) => {
        // read the file into base64, return mimetype and data
        if (document.getElementById(id)) {
            const files = document.getElementById(id).files;
            return new Promise((resolve, reject) => {
                if (files && files[0]) {
                    let f = files[0];   // only read the first file
                    let reader = new FileReader();
                    reader.onload = (function(theFile) {
                        return function(e) {
                            let base64 = btoa(
                                new Uint8Array(e.target.result)
                                    .reduce((data, byte) => data + String.fromCharCode(byte), '')
                                );
                            resolve({type: f.type, data: base64});
                        };
                    })(f);
                    reader.readAsArrayBuffer(f);
                } else {
                    resolve(null);
                }
            });
        } else {
            return Promise.resolve(null);
        }
    },
    editPost: (postId) => {
        window.location = '/private/post?edit=' + encodeURIComponent(postId);
    },
    post: () => {
        const post = document.getElementById('post');
        const cw = document.getElementById('cw');
        const inReplyTo = document.getElementById('inReplyTo');
        const to = document.getElementById('to');
        const editOf = document.getElementById('editOf');
        const description = document.getElementById('description');

        // get hidden elements for poll choices (replying to poll)
        const names = Array.from(document.querySelectorAll('input[class="pollchoice"]')).map((item) => {return item.value});
        // get hidden element for poll designer (sending a new poll)
        let polldata;
        if (document.getElementById('polldata') && document.getElementById('polldata').value) {
            polldata = JSON.parse(document.getElementById('polldata').value);
            if (polldata.choices.includes(null)) {
                polldata = null;    // invalid options
            }
        }

        app.readAttachment('attachment').then((attachment) => {
            const Http = new XMLHttpRequest();
            const proxyUrl ='/private/post';
            Http.open("POST", proxyUrl);
            Http.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
            Http.send(JSON.stringify({
                post: post.value,
                cw: cw.value,
                inReplyTo: inReplyTo.value,
                to: to.value,
                attachment: attachment,
                description: description ? description.value : '',
                names: names,   // list of things being voted for
                polldata: polldata, // poll being created by user
                editOf: editOf ? editOf.value : null
            }));

            Http.onreadystatechange = () => {
                if (Http.readyState == 4 && Http.status == 200) {
                    console.log('posted!');

                    // prepend the new post
                    const newHtml = Http.responseText;
                    const el = document.getElementById('home_stream') || document.getElementById('inbox_stream');

                    if (!el) {
                        window.location = '/private/';
                    }

                    // todo: ideally this would come back with all the html it needs
                    el.innerHTML = newHtml + el.innerHTML;

                    // reset the inputs to blank
                    post.value = '';
                    cw.value = '';
                } else {
                    console.error('HTTP PROXY CHANGE', Http);
                }
            }
        });
        return false;
    },
    replyTo: (activityId, mention) => {
        // get poll form response
        let pollChoices = [];
        Array.from(document.getElementById(activityId).getElementsByTagName('input')).forEach((inp) => {
            if (inp.checked) {
                pollChoices.push(inp.value);
            }
        });
        if (pollChoices.length > 0) {
            window.location = '/private/post?inReplyTo=' + activityId + '&names=' + encodeURIComponent(JSON.stringify(pollChoices));;
        } else {
            window.location = '/private/post?inReplyTo=' + activityId;
        }
        return;

        const inReplyTo = document.getElementById('inReplyTo');
        const post = document.getElementById('post');
        post.value = `@${ mention } `;
        inReplyTo.value = activityId;
        post.focus();
    },
    toggleFollow: (el, userId) => {
        const Http = new XMLHttpRequest();
        const proxyUrl ='/private/follow';
        Http.open("POST", proxyUrl);
        Http.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
        Http.send(JSON.stringify({
            handle: userId,
        }));

        Http.onreadystatechange = () => {
            if (Http.readyState == 4 && Http.status == 200) {
                console.log('followed!');
                const resRaw = Http.responseText;
                const res = JSON.parse(resRaw);

                if (res.isFollowed) {
                    console.log('followed!');
                    el.classList.add("active");
                } else {
                    console.log('unfollowed');
                    el.classList.remove("active");
                }
            } else {
                console.error('HTTP PROXY CHANGE', Http);
            }
        }
        return false;
    },    
    lookup: () => {
        const follow = document.getElementById('lookup');
        const lookup_results = document.getElementById('lookup_results');

        console.log('Lookup user', follow.value);

        const Http = new XMLHttpRequest();
        const proxyUrl ='/private/lookup?handle=' + encodeURIComponent(follow.value);
        console.log(proxyUrl);

        Http.open("GET", proxyUrl);
        Http.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
        Http.send();

        Http.onreadystatechange = () => {
            if (Http.readyState == 4 && Http.status == 200) {
                lookup_results.innerHTML = Http.responseText;
            } else {
                console.error('HTTP PROXY CHANGE', Http);
            }
        }
        return false;
    }    
}
