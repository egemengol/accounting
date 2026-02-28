build:
    mdbook build
    cp -r book/markdown book/html/md
    cp llms.txt book/html/
    cp llms.txt book/markdown/
    cp robots.txt book/html

deploy: build
    rsync -avz --delete book/html/ kindlepathy:/var/www/accounting/

serve: build
    watchexec -r -e md,css,js,html -w src -w theme -w book -- just build \; miniserve --index index.html --compress-response book/html
